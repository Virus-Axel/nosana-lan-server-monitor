import { createFileRoute, Link } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

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

type VcsaCell = {
    character: string;
    foreground: number;
    background: number;
    blink: boolean;
};

type VcsaScreen = {
    rows: number;
    columns: number;
    cursorX: number;
    cursorY: number;
    cells: VcsaCell[];
};

type ServerOutput = {
    output: VcsaScreen | null;
    error: string | null;
    updatedAt: string | null;
    loading: boolean;
};

const POLL_INTERVAL = 5000;

// -----------------------------------------------------------------------------
// VGA colors
// -----------------------------------------------------------------------------

const VGA_COLORS = [
    "#000000",
    "#0000AA",
    "#00AA00",
    "#00AAAA",
    "#AA0000",
    "#AA00AA",
    "#AA5500",
    "#AAAAAA",
    "#555555",
    "#5555FF",
    "#55FF55",
    "#55FFFF",
    "#FF5555",
    "#FF55FF",
    "#FFFF55",
    "#FFFFFF",
];

// -----------------------------------------------------------------------------
// VCSA terminal renderer
// -----------------------------------------------------------------------------

function VcsaTerminal({ screen }: { screen: VcsaScreen }) {
    const containerRef = useRef<HTMLDivElement>(null);

    const [containerSize, setContainerSize] = useState({
        width: 0,
        height: 0,
    });

    const fontSize = 8;
    const lineHeight = fontSize * 1.2;

    // Approximate width of a monospace character at the selected font size.
    const characterWidth = fontSize * 0.602;

    // Number of characters that fit horizontally.
    const charactersPerLine =
        containerSize.width > 0
            ? Math.max(
                1,
                Math.floor(containerSize.width / characterWidth)
            )
            : screen.columns;

    // Number of lines that fit vertically.
    const visibleLines =
        containerSize.height > 0
            ? Math.max(
                1,
                Math.floor(containerSize.height / lineHeight)
            )
            : screen.rows;

    // -------------------------------------------------------------------------
    // Observe container dimensions
    // -------------------------------------------------------------------------

    useEffect(() => {
        const element = containerRef.current;

        if (!element) {
            return;
        }

        const updateSize = () => {
            setContainerSize({
                width: element.clientWidth,
                height: element.clientHeight,
            });
        };

        updateSize();

        const observer = new ResizeObserver(updateSize);
        observer.observe(element);

        return () => observer.disconnect();
    }, []);

    // -------------------------------------------------------------------------
    // Wrap terminal rows
    // -------------------------------------------------------------------------

    const wrappedLines: VcsaCell[][] = [];

    for (let row = 0; row < screen.rows; row++) {
      const rowCells = screen.cells.slice(
          row * screen.columns,
          (row + 1) * screen.columns
      );
      
      // Remove trailing blank cells before wrapping.
      while (
          rowCells.length > 0 &&
          rowCells[rowCells.length - 1].character === " "
      ) {
          rowCells.pop();
      }

        for (
            let i = 0;
            i < rowCells.length;
            i += charactersPerLine
        ) {
            wrappedLines.push(
                rowCells.slice(i, i + charactersPerLine)
            );
        }
    }

    // -------------------------------------------------------------------------
    // Keep the bottom of the terminal visible
    // -------------------------------------------------------------------------

    const visibleWrappedLines = wrappedLines.slice(-visibleLines);

    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------

    return (
        <>
            <style>
                {`
                    @keyframes vcsa-blink {
                        50% {
                            visibility: hidden;
                        }
                    }
                `}
            </style>

            <div
                ref={containerRef}
                className="flex h-full w-full flex-col justify-end overflow-hidden"
                style={{
                    fontFamily: "monospace",
                    fontSize: `${fontSize}px`,
                    lineHeight: 1.2,
                    colorScheme: "only light",
                }}
            >
                <div className="flex shrink-0 flex-col">
                    {visibleWrappedLines.map((line, lineIndex) => (
                        <div
                            key={lineIndex}
                            className="flex"
                            style={{
                                whiteSpace: "pre",
                                height: `${lineHeight}px`,
                                flexShrink: 0,
                            }}
                        >
                            {line.map((cell, cellIndex) => (
                                <span
                                    key={cellIndex}
                                    style={{
                                        color:
                                            VGA_COLORS[cell.foreground] ??
                                            VGA_COLORS[7],

                                        backgroundColor:
                                            VGA_COLORS[cell.background] ??
                                            VGA_COLORS[0],

                                        animation: cell.blink
                                            ? "vcsa-blink 1s steps(1, end) infinite"
                                            : undefined,

                                        width: `${characterWidth}px`,
                                        height: `${lineHeight}px`,
                                        flexShrink: 0,
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                    }}
                                >
                                    {cell.character}
                                </span>
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        </>
    );
}

// -----------------------------------------------------------------------------
// Terminal panel
// -----------------------------------------------------------------------------

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
        <section className="flex h-[280px] min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-[#09090b] shadow-xl">

            {/* Header */}

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

            {/* Terminal output */}

            <div className="min-h-0 flex-1 overflow-hidden bg-[#080808] p-3">

                {!configured && (
                    <div className="font-mono text-sm text-zinc-500">
                        SSH setup required for {host.ip}
                    </div>
                )}

                {configured &&
                    serverOutput?.loading &&
                    !serverOutput.updatedAt && (
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
                    <div className="flex h-full w-full items-end overflow-hidden">
                        <VcsaTerminal screen={serverOutput.output} />
                    </div>
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

            {/* Footer */}

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

// -----------------------------------------------------------------------------
// Dashboard
// -----------------------------------------------------------------------------

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
                                output: previous[host.ip]?.output ?? null,
                                error: null,
                                updatedAt:
                                    previous[host.ip]?.updatedAt ?? null,
                                loading: true,
                            },
                        }));

                        try {
                            const output = await invoke<VcsaScreen>("run_ls", {
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
                                    output:
                                        previous[host.ip]?.output ?? null,
                                    error: String(err),
                                    updatedAt:
                                        previous[host.ip]?.updatedAt ?? null,
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
                            to="/network-config"
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
                            to="/network-config"
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
                                        onChange={(e) =>
                                            setSshUsername(e.target.value)
                                        }
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
                                        onChange={(e) =>
                                            setSshPassword(e.target.value)
                                        }
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
                                        onChange={(e) =>
                                            setFingerprintConfirmed(e.target.checked)
                                        }
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