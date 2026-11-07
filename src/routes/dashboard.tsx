import { createFileRoute, Link } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type ProfileHost = {
    ip: string;
    hostname: string;
    networkCidr: string;
    selected: boolean;
    username?: string | null;
    hostKeyFingerprint?: string | null;
};

type Profile = {
    networks: {
        id: string;
        interface: string;
        ip: string;
        cidr: string;
        enabled: boolean;
    }[];
    hosts: ProfileHost[];
};

type SetupStage = "credentials" | "fingerprint";

type ServerOutput = {
    output: string;
    error: string | null;
    updatedAt: string | null;
    loading: boolean;
};

const POLL_INTERVAL = 5000;

function TerminalPanel({
    host,
    serverOutput,
}: {
    host: ProfileHost;
    serverOutput?: ServerOutput;
}) {
    const configured = Boolean(
        host.username && host.hostKeyFingerprint
    );

    const connected =
        configured &&
        !!serverOutput?.updatedAt &&
        !serverOutput.error &&
        !serverOutput.loading;

    let status = "Setup required";
    let statusColor = "bg-yellow-500";

    if (configured) {
        if (serverOutput?.loading && !serverOutput.updatedAt) {
            status = "Connecting";
            statusColor = "bg-yellow-500";
        } else if (serverOutput?.error) {
            status = "Connection error";
            statusColor = "bg-red-500";
        } else if (connected) {
            status = "Connected";
            statusColor = "bg-emerald-500";
        } else {
            status = "Waiting";
            statusColor = "bg-yellow-500";
        }
    }

    return (
        <section className="flex h-[480px] min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-[#09090b] shadow-xl">
            <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                    <div className="flex shrink-0 items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
                        <span className="h-2.5 w-2.5 rounded-full bg-yellow-500" />
                        <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                    </div>

                    <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-zinc-200">
                            {host.hostname}
                        </div>

                        <div className="text-xs text-zinc-500">
                            {host.username ?? "Not configured"}@{host.ip}
                        </div>
                    </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${statusColor}`} />

                    <span className="text-xs text-zinc-400">
                        {status}
                    </span>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto bg-[#080808] p-3">
                {!configured && (
                    <div className="font-mono text-sm text-zinc-500">
                        SSH setup required for {host.ip}
                    </div>
                )}

                {configured && serverOutput?.loading && !serverOutput.updatedAt && (
                    <div className="font-mono text-sm text-zinc-500">
                        Connecting to {host.ip}...
                    </div>
                )}

                {configured && serverOutput?.error && (
                    <div className="whitespace-pre-wrap break-words font-mono text-sm text-red-400">
                        {serverOutput.error}
                    </div>
                )}

                {configured && serverOutput?.output && (
                    <pre className="w-max min-w-full whitespace-pre font-mono text-[13px] leading-[1.2] text-[#d4d4d4]">
                        {serverOutput.output}
                    </pre>
                )}

                {configured &&
                    !serverOutput?.output &&
                    !serverOutput?.error &&
                    !serverOutput?.loading && (
                        <div className="font-mono text-sm text-zinc-600">
                            Waiting for terminal output...
                        </div>
                    )}
            </div>

            <div className="flex shrink-0 items-center justify-between border-t border-zinc-800 bg-zinc-900 px-3 py-2 text-[11px] text-zinc-500">
                <span>{host.networkCidr}</span>

                <span>
                    {serverOutput?.updatedAt
                        ? `Updated ${new Date(serverOutput.updatedAt).toLocaleTimeString()}`
                        : "No data"}
                </span>
            </div>
        </section>
    );
}

const Dashboard: React.FC = () => {
    const [hosts, setHosts] = useState<ProfileHost[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [serverOutputs, setServerOutputs] = useState<
        Record<string, ServerOutput>
    >({});

    const [setupOpen, setSetupOpen] = useState(false);
    const [setupQueue, setSetupQueue] = useState<ProfileHost[]>([]);
    const [setupIndex, setSetupIndex] = useState(0);

    const [setupStage, setSetupStage] =
        useState<SetupStage>("credentials");

    const [sshUsername, setSshUsername] = useState("");
    const [sshPassword, setSshPassword] = useState("");

    const [fingerprint, setFingerprint] = useState("");
    const [fingerprintConfirmed, setFingerprintConfirmed] =
        useState(false);

    const [setupBusy, setSetupBusy] = useState(false);
    const [setupError, setSetupError] = useState<string | null>(null);

    const currentSetupHost = setupQueue[setupIndex] ?? null;

    const pendingHosts = hosts.filter(
        (host) => !host.username || !host.hostKeyFingerprint
    );

    // -------------------------------------------------------------------------
    // Load profile
    // -------------------------------------------------------------------------

    useEffect(() => {
        async function loadProfile() {
            try {
                const profile = await invoke<Profile | null>("load_profile");

                if (!profile) {
                    setHosts([]);
                    return;
                }

                const selectedHosts = profile.hosts.filter(
                    (host) => host.selected
                );

                setHosts(selectedHosts);

                const needsSetup = selectedHosts.filter(
                    (host) => !host.username || !host.hostKeyFingerprint
                );

                if (needsSetup.length > 0) {
                    setSetupQueue(needsSetup);
                    setSetupIndex(0);
                    setSshUsername(needsSetup[0].username ?? "");
                    setSetupOpen(true);
                }
            } catch (err) {
                setError(String(err));
            } finally {
                setLoading(false);
            }
        }

        loadProfile();
    }, []);

    // -------------------------------------------------------------------------
    // Poll servers
    // -------------------------------------------------------------------------

    useEffect(() => {
        const configuredHosts = hosts.filter(
            (host) => host.username && host.hostKeyFingerprint
        );

        if (configuredHosts.length === 0) {
            return;
        }

        let active = true;
        let running = false;

        async function updateServers() {
            if (running || !active) {
                return;
            }

            running = true;

            try {
                await Promise.all(
                    configuredHosts.map(async (host) => {
                        if (!active) {
                            return;
                        }

                        setServerOutputs((previous) => ({
                            ...previous,
                            [host.ip]: {
                                ...previous[host.ip],
                                output: previous[host.ip]?.output ?? "",
                                error: null,
                                updatedAt: previous[host.ip]?.updatedAt ?? null,
                                loading: true,
                            },
                        }));

                        try {
                            const output = await invoke<string>("run_ls", {
                                ip: host.ip,
                            });

                            if (!active) {
                                return;
                            }

                            setServerOutputs((previous) => ({
                                ...previous,
                                [host.ip]: {
                                    output,
                                    error: null,
                                    updatedAt: new Date().toISOString(),
                                    loading: false,
                                },
                            }));
                        } catch (err) {
                            if (!active) {
                                return;
                            }

                            setServerOutputs((previous) => ({
                                ...previous,
                                [host.ip]: {
                                    output: previous[host.ip]?.output ?? "",
                                    error: String(err),
                                    updatedAt: previous[host.ip]?.updatedAt ?? null,
                                    loading: false,
                                },
                            }));
                        }
                    })
                );
            } finally {
                running = false;
            }
        }

        updateServers();

        const interval = setInterval(updateServers, POLL_INTERVAL);

        return () => {
            active = false;
            clearInterval(interval);
        };
    }, [hosts]);

    // -------------------------------------------------------------------------
    // SSH setup
    // -------------------------------------------------------------------------

    function beginSshSetup() {
        const needsSetup = hosts.filter(
            (host) => !host.username || !host.hostKeyFingerprint
        );

        if (needsSetup.length === 0) {
            return;
        }

        setSetupQueue(needsSetup);
        setSetupIndex(0);
        setSshUsername(needsSetup[0].username ?? "");
        setSshPassword("");
        setFingerprint("");
        setFingerprintConfirmed(false);
        setSetupStage("credentials");
        setSetupError(null);
        setSetupOpen(true);
    }

    function cancelSshSetup() {
        setSshPassword("");
        setFingerprint("");
        setFingerprintConfirmed(false);
        setSetupStage("credentials");
        setSetupError(null);
        setSetupOpen(false);
    }

    async function retrieveFingerprint() {
        if (!currentSetupHost) {
            return;
        }

        if (!sshUsername.trim()) {
            setSetupError("Enter an SSH username.");
            return;
        }

        if (!sshPassword) {
            setSetupError("Enter the SSH password.");
            return;
        }

        setSetupBusy(true);
        setSetupError(null);

        try {
            const result = await invoke<string>(
                "get_ssh_host_fingerprint",
                {
                    ip: currentSetupHost.ip,
                }
            );

            setFingerprint(result);
            setFingerprintConfirmed(false);
            setSetupStage("fingerprint");
        } catch (err) {
            setSetupError(String(err));
        } finally {
            setSetupBusy(false);
        }
    }

    async function authenticateAndSave() {
        if (!currentSetupHost) {
            return;
        }

        if (!fingerprintConfirmed) {
            setSetupError("Confirm the server fingerprint first.");
            return;
        }

        setSetupBusy(true);
        setSetupError(null);

        try {
            await invoke("authenticate_ssh", {
                ip: currentSetupHost.ip,
                username: sshUsername.trim(),
                password: sshPassword,
                expectedFingerprint: fingerprint,
            });

            setHosts((previous) =>
                previous.map((host) =>
                    host.ip === currentSetupHost.ip
                        ? {
                            ...host,
                            username: sshUsername.trim(),
                            hostKeyFingerprint: fingerprint,
                        }
                        : host
                )
            );

            setSshPassword("");
            setFingerprint("");
            setFingerprintConfirmed(false);
            setSetupStage("credentials");

            const nextIndex = setupIndex + 1;

            if (nextIndex >= setupQueue.length) {
                setSetupOpen(false);
            } else {
                setSetupIndex(nextIndex);
                setSshUsername(
                    setupQueue[nextIndex].username ?? ""
                );
            }
        } catch (err) {
            setSetupError(String(err));
        } finally {
            setSetupBusy(false);
        }
    }

    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------

    return (
        <main className="min-h-screen bg-zinc-950 text-zinc-100">
            <div className="mx-auto max-w-[1800px] px-6 py-8">

                <header className="mb-8 flex items-center justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-semibold tracking-tight">
                            Server dashboard
                        </h1>

                        <p className="mt-1 text-sm text-zinc-500">
                            Live server monitoring · Updates every 5 seconds
                        </p>
                    </div>

                    <div className="flex items-center gap-3">
                        {!loading && pendingHosts.length > 0 && (
                            <button
                                onClick={beginSshSetup}
                                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
                            >
                                Configure SSH ({pendingHosts.length})
                            </button>
                        )}

                        <Link
                            to="/"
                            className="rounded-lg border border-zinc-800 px-4 py-2 text-sm text-zinc-300 transition hover:bg-zinc-900"
                        >
                            Network setup
                        </Link>
                    </div>
                </header>

                {error && (
                    <div className="mb-6 rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
                        {error}
                    </div>
                )}

                {loading && (
                    <div className="py-20 text-center text-sm text-zinc-500">
                        Loading configuration...
                    </div>
                )}

                {!loading && !error && hosts.length === 0 && (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-16 text-center">
                        <h2 className="text-lg font-medium">
                            No servers selected
                        </h2>

                        <p className="mt-2 text-sm text-zinc-500">
                            Select some hosts in the network setup first.
                        </p>

                        <Link
                            to="/"
                            className="mt-5 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
                        >
                            Open network setup
                        </Link>
                    </div>
                )}

                {!loading && hosts.length > 0 && (
                    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                        {hosts.map((host) => (
                            <TerminalPanel
                                key={`${host.networkCidr}-${host.ip}`}
                                host={host}
                                serverOutput={serverOutputs[host.ip]}
                            />
                        ))}
                    </div>
                )}

                {!loading && hosts.length > 0 && (
                    <footer className="mt-6 flex justify-between text-xs text-zinc-600">
                        <span>{hosts.length} servers</span>
                        <span>Polling interval: {POLL_INTERVAL / 1000}s</span>
                    </footer>
                )}
            </div>

            {/* SSH setup dialog */}

            {setupOpen && currentSetupHost && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
                    <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
                        <div className="mb-6">
                            <div className="text-xs font-medium uppercase tracking-wider text-blue-400">
                                SSH configuration
                            </div>

                            <h2 className="mt-2 text-xl font-semibold">
                                Connect to {currentSetupHost.hostname}
                            </h2>

                            <p className="mt-1 text-sm text-zinc-500">
                                {currentSetupHost.ip}
                            </p>

                            <p className="mt-3 text-xs text-zinc-600">
                                Server {setupIndex + 1} of {setupQueue.length}
                            </p>
                        </div>

                        {setupStage === "credentials" && (
                            <div className="space-y-4">
                                <p className="text-sm text-zinc-400">
                                    Enter your SSH credentials for the initial login.
                                    The password will not be saved.
                                </p>

                                <div>
                                    <label className="mb-1 block text-sm text-zinc-300">
                                        Username
                                    </label>

                                    <input
                                        type="text"
                                        autoComplete="username"
                                        value={sshUsername}
                                        onChange={(e) => setSshUsername(e.target.value)}
                                        placeholder="axel"
                                        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-500"
                                    />
                                </div>

                                <div>
                                    <label className="mb-1 block text-sm text-zinc-300">
                                        Password
                                    </label>

                                    <input
                                        type="password"
                                        autoComplete="current-password"
                                        value={sshPassword}
                                        onChange={(e) => setSshPassword(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                                retrieveFingerprint();
                                            }
                                        }}
                                        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-500"
                                    />
                                </div>

                                <p className="text-xs leading-relaxed text-zinc-600">
                                    The password is used only to authenticate this
                                    initial connection. It is not written to disk.
                                </p>
                            </div>
                        )}

                        {setupStage === "fingerprint" && (
                            <div className="space-y-4">
                                <p className="text-sm leading-relaxed text-zinc-400">
                                    Verify that this is the correct server before
                                    sending your password.
                                </p>

                                <div className="rounded-lg border border-zinc-700 bg-zinc-950 p-4">
                                    <div className="mb-2 text-xs text-zinc-500">
                                        SSH SHA-256 host-key fingerprint
                                    </div>

                                    <div className="break-all font-mono text-sm text-emerald-400">
                                        {fingerprint}
                                    </div>
                                </div>

                                <label className="flex cursor-pointer items-start gap-3 text-sm text-zinc-300">
                                    <input
                                        type="checkbox"
                                        checked={fingerprintConfirmed}
                                        onChange={(e) => setFingerprintConfirmed(e.target.checked)}
                                        className="mt-1"
                                    />

                                    <span>
                                        I have verified this fingerprint and trust
                                        this server.
                                    </span>
                                </label>

                                <p className="text-xs leading-relaxed text-zinc-600">
                                    Ideally, compare this fingerprint with one
                                    obtained through a trusted channel, such as
                                    the server console.
                                </p>
                            </div>
                        )}

                        {setupError && (
                            <div className="mt-4 rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
                                {setupError}
                            </div>
                        )}

                        <div className="mt-6 flex justify-between gap-3">
                            <button
                                onClick={cancelSshSetup}
                                disabled={setupBusy}
                                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
                            >
                                Cancel
                            </button>

                            {setupStage === "credentials" ? (
                                <button
                                    onClick={retrieveFingerprint}
                                    disabled={setupBusy}
                                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
                                >
                                    {setupBusy ? "Connecting..." : "Continue"}
                                </button>
                            ) : (
                                <button
                                    onClick={authenticateAndSave}
                                    disabled={setupBusy || !fingerprintConfirmed}
                                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
                                >
                                    {setupBusy
                                        ? "Authenticating..."
                                        : "Authenticate and save"}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </main>
    );
};

export const Route = createFileRoute("/dashboard")({
    component: Dashboard,
});