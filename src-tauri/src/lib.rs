
use std::{
    fs,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::PathBuf,
    process::Command,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use if_addrs::{get_if_addrs, IfAddr};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ssh2::Session;
use ssh_key::{rand_core::OsRng, Algorithm, LineEnding, PrivateKey};
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

// -----------------------------------------------------------------------------
// Network types
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lan {
    id: String,
    interface: String,
    ip: String,
    cidr: String,
    whitelisted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Host {
    ip: String,
    hostname: String,
    #[serde(rename = "networkCidr")]
    network_cidr: String,
}

// -----------------------------------------------------------------------------
// Profile types
// -----------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileNetwork {
    id: String,
    interface: String,
    ip: String,
    cidr: String,
    enabled: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileHost {
    ip: String,
    hostname: String,
    network_cidr: String,
    selected: bool,

    #[serde(default)]
    username: Option<String>,

    #[serde(default)]
    host_key_fingerprint: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    networks: Vec<ProfileNetwork>,
    hosts: Vec<ProfileHost>,
}

// -----------------------------------------------------------------------------
// SSH directory and key generation
// -----------------------------------------------------------------------------

/// Resolve the application's SSH directory.
///
/// Desktop:
/// Uses ~/.ssh when HOME is available.
///
/// Android:
/// Uses Tauri's application configuration directory.
fn get_ssh_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(not(target_os = "android"))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let ssh_dir = PathBuf::from(home).join(".ssh");

            fs::create_dir_all(&ssh_dir)
                .map_err(|e| format!("Could not create SSH directory: {e}"))?;

            return Ok(ssh_dir);
        }
    }

    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not determine app config directory: {e}"))?;

    let ssh_dir = config_dir.join(".ssh");

    fs::create_dir_all(&ssh_dir)
        .map_err(|e| format!("Could not create SSH directory: {e}"))?;

    Ok(ssh_dir)
}

/// Set restrictive permissions on a private key on Unix platforms.
#[cfg(unix)]
fn secure_private_key(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("Could not secure private SSH key: {e}"))
}

#[cfg(not(unix))]
fn secure_private_key(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

/// Write an Ed25519 key pair to disk.
fn generate_ssh_key_pair(
    private_key_path: &std::path::Path,
    public_key_path: &std::path::Path,
) -> Result<(), String> {
    println!("Generating a new Ed25519 SSH key pair...");

    let mut private_key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519)
        .map_err(|e| format!("Could not generate SSH key: {e}"))?;

    private_key.set_comment("nlsm");

    let private_key_data = private_key
        .to_openssh(LineEnding::LF)
        .map_err(|e| format!("Could not encode private SSH key: {e}"))?;

    let public_key_data = private_key
        .public_key()
        .to_openssh()
        .map_err(|e| format!("Could not encode public SSH key: {e}"))?;

    fs::write(private_key_path, private_key_data.as_bytes())
        .map_err(|e| format!("Could not save private SSH key: {e}"))?;

    secure_private_key(private_key_path)?;

    fs::write(public_key_path, format!("{public_key_data}\n"))
        .map_err(|e| format!("Could not save public SSH key: {e}"))?;

    println!("Ed25519 SSH key pair generated successfully.");

    Ok(())
}

/// Ensure that an Ed25519 key pair exists.
///
/// If the private key exists but the public key is missing, the public key
/// is reconstructed from the private key instead of generating a new pair.
///
/// If the private key is missing, a new pair is generated.
fn ensure_ssh_key_pair(app: &AppHandle) -> Result<PathBuf, String> {
    let ssh_dir = get_ssh_dir(app)?;

    let private_key_path = ssh_dir.join("id_ed25519");
    let public_key_path = ssh_dir.join("id_ed25519.pub");

    let private_exists = private_key_path.is_file();
    let public_exists = public_key_path.is_file();

    if private_exists && public_exists {
        return Ok(ssh_dir);
    }

    if private_exists {
        println!("SSH public key is missing. Reconstructing it from the private key...");

        let private_key_data = fs::read_to_string(&private_key_path)
            .map_err(|e| format!("Could not read private SSH key: {e}"))?;

        let private_key = PrivateKey::from_openssh(&private_key_data)
            .map_err(|e| format!("Could not parse existing private SSH key: {e}"))?;

        let public_key_data = private_key
            .public_key()
            .to_openssh()
            .map_err(|e| format!("Could not reconstruct public SSH key: {e}"))?;

        fs::write(&public_key_path, format!("{public_key_data}\n"))
            .map_err(|e| format!("Could not save reconstructed public key: {e}"))?;

        return Ok(ssh_dir);
    }

    generate_ssh_key_pair(&private_key_path, &public_key_path)?;

    Ok(ssh_dir)
}

/// Read the local Ed25519 public key.
fn read_public_key(app: &AppHandle) -> Result<String, String> {
    let ssh_dir = ensure_ssh_key_pair(app)?;
    let public_key_path = ssh_dir.join("id_ed25519.pub");

    let public_key = fs::read_to_string(&public_key_path).map_err(|e| {
        format!(
            "Could not read public key {}: {e}",
            public_key_path.display()
        )
    })?;

    let public_key = public_key.trim();

    if public_key.is_empty() {
        return Err("The local SSH public key is empty".into());
    }

    if public_key.contains('\n') || public_key.contains('\r') {
        return Err("The SSH public key contains unexpected line breaks".into());
    }

    if !public_key.starts_with("ssh-ed25519 ") {
        return Err("Expected an Ed25519 public key in id_ed25519.pub".into());
    }

    Ok(public_key.to_string())
}

/// Escape a string for safe use inside a single-quoted shell argument.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Install the local public key into the remote user's authorized_keys.
fn install_public_key(session: &Session, public_key: &str) -> Result<(), String> {
    let quoted_key = shell_quote(public_key);

    let command = format!(
        "umask 077 && \
         mkdir -p \"$HOME/.ssh\" && \
         touch \"$HOME/.ssh/authorized_keys\" && \
         (grep -qxF -- {quoted_key} \"$HOME/.ssh/authorized_keys\" || \
          printf '%s\\n' {quoted_key} >> \"$HOME/.ssh/authorized_keys\") && \
         chmod 700 \"$HOME/.ssh\" && \
         chmod 600 \"$HOME/.ssh/authorized_keys\""
    );

    let mut channel = session
        .channel_session()
        .map_err(|e| format!("Could not open SSH channel: {e}"))?;

    channel
        .exec(&command)
        .map_err(|e| format!("Could not install SSH public key: {e}"))?;

    let mut stdout = String::new();

    channel
        .read_to_string(&mut stdout)
        .map_err(|e| format!("Could not read key installation output: {e}"))?;

    let mut stderr = String::new();

    channel
        .stderr()
        .read_to_string(&mut stderr)
        .map_err(|e| format!("Could not read key installation errors: {e}"))?;

    channel
        .wait_close()
        .map_err(|e| format!("Could not close SSH channel: {e}"))?;

    let exit_status = channel
        .exit_status()
        .map_err(|e| format!("Could not read installation exit status: {e}"))?;

    if exit_status != 0 {
        return Err(if stderr.trim().is_empty() {
            format!("Public key installation failed with status {exit_status}")
        } else {
            format!("Public key installation failed: {}", stderr.trim())
        });
    }

    Ok(())
}

// -----------------------------------------------------------------------------
// VCSA group configuration
// -----------------------------------------------------------------------------

/// Add the configured user to the group owning /dev/vcsa1.
///
/// The sudo password is supplied through SSH stdin and is never included
/// in the remote command or saved to the profile.
fn add_user_to_vcsa_group(
    session: &Session,
    username: &str,
    password: &str,
) -> Result<(), String> {
    let username = shell_quote(username);

    let command = format!(
        r#"
        group="$(stat -c '%G' /dev/vcsa1)" || exit 10

        case "$group" in
            ''|*[!A-Za-z0-9_.-]*)
                echo "Invalid vcsa1 group name" >&2
                exit 11
                ;;
        esac

        if id -nG {username} | tr ' ' '\n' | grep -Fxq "$group"; then
            exit 0
        fi

        sudo -k -S -p '' usermod -aG "$group" {username} || exit $?

        id -nG {username} | tr ' ' '\n' | grep -Fxq "$group" || {{
            echo "Failed to verify group membership" >&2
            exit 12
        }}
        "#
    );

    let mut channel = session
        .channel_session()
        .map_err(|e| format!("Failed to open SSH channel: {e}"))?;

    channel
        .exec(&command)
        .map_err(|e| format!("Failed to execute group setup: {e}"))?;

    channel
        .write_all(password.as_bytes())
        .map_err(|e| format!("Failed to send sudo password: {e}"))?;

    channel
        .write_all(b"\n")
        .map_err(|e| format!("Failed to send sudo password: {e}"))?;

    channel
        .send_eof()
        .map_err(|e| format!("Failed to close SSH stdin: {e}"))?;

    let mut stdout = String::new();
    let mut stderr = String::new();

    channel
        .read_to_string(&mut stdout)
        .map_err(|e| format!("Failed to read group setup output: {e}"))?;

    channel
        .stderr()
        .read_to_string(&mut stderr)
        .map_err(|e| format!("Failed to read group setup errors: {e}"))?;

    channel
        .wait_close()
        .map_err(|e| format!("Failed waiting for group setup: {e}"))?;

    let status = channel
        .exit_status()
        .map_err(|e| format!("Failed to get group setup status: {e}"))?;

    if status != 0 {
        return Err(format!(
            "Failed to add user to the vcsa1 group (exit code {status}): {}",
            stderr.trim()
        ));
    }

    Ok(())
}

// -----------------------------------------------------------------------------
// Network discovery
// -----------------------------------------------------------------------------

#[tauri::command]
fn get_networks() -> Result<Vec<Lan>, String> {
    let interfaces =
        get_if_addrs().map_err(|e| format!("Could not enumerate network interfaces: {e}"))?;

    println!("=== NETWORK DISCOVERY ===");
    println!("Found {} interfaces", interfaces.len());

    let mut networks = Vec::new();

    for interface in interfaces {
        println!("Interface: {}", interface.name);

        let (ip, mask) = match &interface.addr {
            IfAddr::V4(addr) => {
                println!("  IPv4: {}", addr.ip);
                println!("  Netmask: {}", addr.netmask);
                (addr.ip, addr.netmask)
            }
            IfAddr::V6(addr) => {
                println!("  IPv6: {}", addr.ip);
                println!("  Skipping IPv6");
                continue;
            }
        };

        if ip.is_loopback() || ip.is_unspecified() || ip.is_link_local() {
            println!("  Skipping: loopback, unspecified or link-local");
            continue;
        }

        let prefix = match netmask_to_prefix(mask) {
            Some(prefix) => prefix,
            None => {
                println!("  Skipping: invalid netmask");
                continue;
            }
        };

        let network_ip = Ipv4Addr::from(u32::from(ip) & u32::from(mask));
        let cidr = format!("{network_ip}/{prefix}");

        println!("  Discovered network: {cidr}");

        networks.push(Lan {
            id: format!("{}:{}", interface.name, cidr),
            interface: interface.name,
            ip: ip.to_string(),
            cidr,
            whitelisted: false,
        });
    }

    println!("Total discovered networks: {}", networks.len());
    println!("=========================");

    networks.sort_by(|a, b| {
        a.interface
            .cmp(&b.interface)
            .then(a.cidr.cmp(&b.cidr))
    });

    Ok(networks)
}

fn netmask_to_prefix(mask: Ipv4Addr) -> Option<u32> {
    let bits = u32::from(mask);
    let prefix = bits.leading_ones();

    let expected = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };

    if bits == expected {
        Some(prefix)
    } else {
        None
    }
}

// -----------------------------------------------------------------------------
// Network scanning
// -----------------------------------------------------------------------------

#[tauri::command]
async fn scan_network(cidr: String) -> Result<Vec<Host>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_network_blocking(&cidr))
        .await
        .map_err(|e| format!("Scan task failed: {e}"))?
}

fn scan_network_blocking(cidr: &str) -> Result<Vec<Host>, String> {
    let networks = get_networks()?;

    if !networks.iter().any(|network| network.cidr == cidr) {
        return Err(format!(
            "Network {cidr} is not available on a local interface"
        ));
    }

    let (network_ip, prefix) = parse_cidr(cidr)?;

    if !(20..=32).contains(&prefix) {
        return Err(format!(
            "Network prefix /{prefix} is not supported. Use /20 through /32."
        ));
    }

    let network_number = u32::from(network_ip);
    let host_count = 1u32 << (32 - prefix);

    let first_host = if prefix <= 30 {
        network_number + 1
    } else {
        network_number
    };

    let last_host = if prefix <= 30 {
        network_number + host_count - 2
    } else {
        network_number + host_count - 1
    };

    let network_cidr = cidr.to_string();

    let (tx, rx) = mpsc::channel::<Host>();
    let next_ip = Arc::new(Mutex::new(first_host));

    let worker_count = 64usize.min((last_host - first_host + 1) as usize);

    let mut workers = Vec::new();

    for _ in 0..worker_count {
        let tx = tx.clone();
        let next_ip = Arc::clone(&next_ip);
        let network_cidr = network_cidr.clone();

        workers.push(thread::spawn(move || loop {
            let ip_number = {
                let mut next = next_ip.lock().unwrap();

                if *next > last_host {
                    break;
                }

                let current = *next;
                *next += 1;
                current
            };

            let ip = Ipv4Addr::from(ip_number);

            if !ping_host(ip) {
                continue;
            }

            let hostname = resolve_hostname(ip).unwrap_or_else(|| ip.to_string());

            let host = Host {
                ip: ip.to_string(),
                hostname,
                network_cidr: network_cidr.clone(),
            };

            if tx.send(host).is_err() {
                break;
            }
        }));
    }

    drop(tx);

    let mut hosts: Vec<Host> = rx.into_iter().collect();

    for worker in workers {
        let _ = worker.join();
    }

    hosts.sort_by(|a, b| {
        a.ip
            .parse::<Ipv4Addr>()
            .ok()
            .cmp(&b.ip.parse::<Ipv4Addr>().ok())
    });

    Ok(hosts)
}

fn parse_cidr(cidr: &str) -> Result<(Ipv4Addr, u32), String> {
    let (ip, prefix) = cidr
        .split_once('/')
        .ok_or_else(|| format!("Invalid CIDR: {cidr}"))?;

    let ip: Ipv4Addr = ip
        .parse()
        .map_err(|e| format!("Invalid IPv4 address: {e}"))?;

    let prefix: u32 = prefix
        .parse()
        .map_err(|e| format!("Invalid prefix: {e}"))?;

    if prefix > 32 {
        return Err("CIDR prefix must be between 0 and 32".into());
    }

    Ok((ip, prefix))
}

fn ping_host(ip: Ipv4Addr) -> bool {
    Command::new("ping")
        .args(["-n", "-c", "1", "-W", "1", &ip.to_string()])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn resolve_hostname(ip: Ipv4Addr) -> Option<String> {
    dns_lookup::lookup_addr(&std::net::IpAddr::V4(ip))
        .ok()
        .filter(|hostname| !hostname.is_empty())
}

// -----------------------------------------------------------------------------
// SSH connection and host fingerprint
// -----------------------------------------------------------------------------

fn connect_ssh(ip: &str) -> Result<(Session, String), String> {
    let ip: IpAddr = ip
        .parse()
        .map_err(|e| format!("Invalid server IP address: {e}"))?;

    let address = SocketAddr::new(ip, 22);

    let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(5))
        .map_err(|e| format!("Could not connect to SSH server: {e}"))?;

    tcp.set_read_timeout(Some(Duration::from_secs(8)))
        .map_err(|e| e.to_string())?;

    tcp.set_write_timeout(Some(Duration::from_secs(8)))
        .map_err(|e| e.to_string())?;

    let mut session =
        Session::new().map_err(|e| format!("Could not create SSH session: {e}"))?;

    session.set_tcp_stream(tcp);
    session.set_timeout(10_000);

    session
        .handshake()
        .map_err(|e| format!("SSH handshake failed: {e}"))?;

    let (host_key, _) = session
        .host_key()
        .ok_or_else(|| "SSH server did not provide a host key".to_string())?;

    let digest = Sha256::digest(host_key);

    let fingerprint = format!("SHA256:{}", STANDARD_NO_PAD.encode(digest));

    Ok((session, fingerprint))
}

/// Retrieve the SSH host-key fingerprint.
#[tauri::command]
async fn get_ssh_host_fingerprint(ip: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, fingerprint) = connect_ssh(&ip)?;
        Ok(fingerprint)
    })
    .await
    .map_err(|e| format!("SSH fingerprint task failed: {e}"))?
}

// -----------------------------------------------------------------------------
// SSH authentication
// -----------------------------------------------------------------------------

#[tauri::command]
async fn authenticate_ssh(
    app: AppHandle,
    ip: String,
    username: String,
    password: String,
    expected_fingerprint: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let username = username.trim().to_string();

        if username.is_empty() {
            return Err("SSH username cannot be empty".to_string());
        }

        let password = Zeroizing::new(password);

        let public_key = read_public_key(&app)?;

        let (mut session, actual_fingerprint) = connect_ssh(&ip)?;

        if actual_fingerprint != expected_fingerprint {
            return Err(
                "The SSH host key changed between verification and authentication. \
                 No password was sent. Please verify the server again."
                    .to_string(),
            );
        }

        session
            .userauth_password(&username, password.as_str())
            .map_err(|e| format!("SSH password authentication failed: {e}"))?;

        if !session.authenticated() {
            return Err("SSH password authentication was not successful".into());
        }

        install_public_key(&session, &public_key)?;

        add_user_to_vcsa_group(&session, &username, &password)?;

        drop(session);

        let (verification_session, verification_fingerprint) = connect_ssh(&ip)?;

        if verification_fingerprint != expected_fingerprint {
            return Err("The SSH host key changed during key installation.".into());
        }

        authenticate_with_key(&verification_session, &username, &app).map_err(|e| {
            format!(
                "The public key was installed, but key authentication \
                 could not be verified: {e}"
            )
        })?;

        save_ssh_identity(&app, &ip, &username, &actual_fingerprint)?;

        Ok(())
    })
    .await
    .map_err(|e| format!("SSH authentication task failed: {e}"))?
}

// -----------------------------------------------------------------------------
// SSH key authentication
// -----------------------------------------------------------------------------

/// Authenticate using keys available through the SSH agent, then try
/// standard private-key files.
///
/// Private-key files are read by Rust and passed to libssh2 as memory.
/// This avoids libssh2 needing to open files in Android's private storage.
fn authenticate_with_key(
    session: &Session,
    username: &str,
    app: &AppHandle,
) -> Result<(), String> {
    // Try SSH agent identities first.
    if let Ok(mut agent) = session.agent() {
        if agent.connect().is_ok() && agent.list_identities().is_ok() {
            if let Ok(identities) = agent.identities() {
                for identity in identities {
                    if agent.userauth(username, &identity).is_ok()
                        && session.authenticated()
                    {
                        return Ok(());
                    }
                }
            }
        }
    }

    let ssh_dir = get_ssh_dir(app)?;

    let key_files = [
        ssh_dir.join("id_ed25519"),
        ssh_dir.join("id_rsa"),
        ssh_dir.join("id_ecdsa"),
    ];

    let mut errors = Vec::new();

    for key_file in key_files {
        if !key_file.is_file() {
            continue;
        }

        // Read the key using Rust instead of letting libssh2 open the file.
        let private_key = match fs::read_to_string(&key_file) {
            Ok(key) => key,
            Err(error) => {
                errors.push(format!(
                    "{}: unable to read private key: {}",
                    key_file.display(),
                    error
                ));
                continue;
            }
        };

        // Pass the key contents directly to libssh2.
        match session.userauth_pubkey_memory(
            username,
            None,
            &private_key,
            None,
        ) {
            Ok(()) if session.authenticated() => return Ok(()),
            Ok(()) => {
                errors.push(format!(
                    "{}: authentication did not complete",
                    key_file.display()
                ));
            }
            Err(error) => {
                errors.push(format!("{}: {:?}", key_file.display(), error));
            }
        }
    }

    let details = if errors.is_empty() {
        "No usable SSH agent identity or standard private key was found.".to_string()
    } else {
        errors.join("; ")
    };

    Err(format!(
        "SSH key authentication failed for {username}. {details}"
    ))
}

// -----------------------------------------------------------------------------
// VCSA decoding
// -----------------------------------------------------------------------------

fn decode_vcsa(data: &[u8]) -> Result<String, String> {
    if data.len() < 4 {
        return Err("Invalid VCSA data: missing header".into());
    }

    let rows = data[0] as usize;
    let cols = data[1] as usize;

    if rows == 0 || cols == 0 {
        return Err("Invalid VCSA dimensions".into());
    }

    let expected_size = 4usize
        .checked_add(
            rows.checked_mul(cols)
                .and_then(|cells| cells.checked_mul(2))
                .ok_or_else(|| "VCSA dimensions overflow".to_string())?,
        )
        .ok_or_else(|| "VCSA data size overflow".to_string())?;

    if data.len() < expected_size {
        return Err(format!(
            "Incomplete VCSA data: expected {expected_size} bytes, got {}",
            data.len()
        ));
    }

    let mut output = String::with_capacity(rows * (cols + 1));

    for row in 0..rows {
        for col in 0..cols {
            let index = 4 + (row * cols + col) * 2;
            let character = data[index];

            let character = match character {
                32..=126 => character as char,
                _ => ' ',
            };

            output.push(character);
        }

        output.push('\n');
    }

    Ok(output)
}

// -----------------------------------------------------------------------------
// Read VCSA from a server
// -----------------------------------------------------------------------------

fn run_ls_blocking(app: &AppHandle, ip: &str) -> Result<String, String> {
    let path = profile_path(app)?;

    if !path.exists() {
        return Err("No saved profile was found".into());
    }

    let profile = read_profile(&path)?;

    let host = profile
        .hosts
        .iter()
        .find(|host| host.ip == ip)
        .ok_or_else(|| format!("Server {ip} was not found in the profile"))?;

    if !host.selected {
        return Err(format!("Server {ip} is not selected"));
    }

    let username = host
        .username
        .as_deref()
        .filter(|username| !username.trim().is_empty())
        .ok_or_else(|| format!("No SSH username configured for {ip}"))?;

    let expected_fingerprint = host
        .host_key_fingerprint
        .as_deref()
        .ok_or_else(|| format!("No SSH host fingerprint saved for {ip}"))?;

    let (session, actual_fingerprint) = connect_ssh(ip)?;

    if actual_fingerprint != expected_fingerprint {
        return Err(format!(
            "SSH host key mismatch for {ip}. \
             The server identity has changed. Please verify it again."
        ));
    }

    authenticate_with_key(&session, username, app)?;

    let mut channel = session
        .channel_session()
        .map_err(|e| format!("Could not open SSH channel: {e}"))?;

    channel
        .exec("cat /dev/vcsa1")
        .map_err(|e| format!("Could not read /dev/vcsa1 on {ip}: {e}"))?;

    let mut raw_output = Vec::new();

    channel
        .read_to_end(&mut raw_output)
        .map_err(|e| format!("Could not read VCSA data from {ip}: {e}"))?;

    let mut stderr = String::new();

    channel
        .stderr()
        .read_to_string(&mut stderr)
        .map_err(|e| format!("Could not read SSH error output from {ip}: {e}"))?;

    channel
        .wait_close()
        .map_err(|e| format!("Could not close SSH channel: {e}"))?;

    let exit_status = channel
        .exit_status()
        .map_err(|e| format!("Could not read command exit status: {e}"))?;

    if exit_status != 0 {
        return Err(if stderr.trim().is_empty() {
            format!("cat /dev/vcsa1 exited with status {exit_status} on {ip}")
        } else {
            format!("VCSA read failed on {ip}: {}", stderr.trim())
        });
    }

    decode_vcsa(&raw_output)
}

#[tauri::command]
async fn run_ls(app: AppHandle, ip: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_ls_blocking(&app, &ip))
        .await
        .map_err(|e| format!("SSH VCSA task failed: {e}"))?
}

// -----------------------------------------------------------------------------
// Profile persistence
// -----------------------------------------------------------------------------

fn profile_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;

    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Could not create config directory: {e}"))?;

    Ok(config_dir.join("profile.json"))
}

fn read_profile(path: &PathBuf) -> Result<Profile, String> {
    let contents =
        fs::read_to_string(path).map_err(|e| format!("Could not read profile: {e}"))?;

    serde_json::from_str(&contents).map_err(|e| format!("Could not parse profile: {e}"))
}

fn write_profile(path: &PathBuf, profile: &Profile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(profile)
        .map_err(|e| format!("Could not serialize profile: {e}"))?;

    fs::write(path, json).map_err(|e| format!("Could not save profile: {e}"))
}

fn save_ssh_identity(
    app: &AppHandle,
    ip: &str,
    username: &str,
    fingerprint: &str,
) -> Result<(), String> {
    let path = profile_path(app)?;
    let mut profile = read_profile(&path)?;

    let host = profile
        .hosts
        .iter_mut()
        .find(|host| host.ip == ip)
        .ok_or_else(|| format!("Server {ip} was not found in the saved profile"))?;

    host.username = Some(username.to_string());
    host.host_key_fingerprint = Some(fingerprint.to_string());

    write_profile(&path, &profile)
}

#[tauri::command]
fn save_profile(app: AppHandle, mut profile: Profile) -> Result<String, String> {
    let path = profile_path(&app)?;

    if path.exists() {
        let old_profile = read_profile(&path)?;

        for host in &mut profile.hosts {
            if let Some(old_host) = old_profile
                .hosts
                .iter()
                .find(|old| old.ip == host.ip && old.network_cidr == host.network_cidr)
            {
                if host.username.is_none() {
                    host.username = old_host.username.clone();
                }

                if host.host_key_fingerprint.is_none() {
                    host.host_key_fingerprint = old_host.host_key_fingerprint.clone();
                }
            }
        }
    }

    write_profile(&path, &profile)?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn load_profile(app: AppHandle) -> Result<Option<Profile>, String> {
    let path = profile_path(&app)?;

    if !path.exists() {
        return Ok(None);
    }

    Ok(Some(read_profile(&path)?))
}

// -----------------------------------------------------------------------------
// Tauri entry point
// -----------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_networks,
            scan_network,
            save_profile,
            load_profile,
            get_ssh_host_fingerprint,
            authenticate_ssh,
            run_ls
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}