import { createFileRoute, Link } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

type Lan = {
    id: string;
    interface: string;
    ip: string;
    cidr: string;
    whitelisted: boolean;
};

type Host = {
    ip: string;
    hostname: string;
    networkCidr: string;
    selected: boolean;
};

type Profile = {
    networks: {
        id: string;
        interface: string;
        ip: string;
        cidr: string;
        enabled: boolean;
    }[];
    hosts: Host[];
};

const Home: React.FC = () => {
    const [networks, setNetworks] = useState<Lan[]>([]);
    const [hosts, setHosts] = useState<Host[]>([]);

    const [loadingNetworks, setLoadingNetworks] = useState(false);
    const [scanningNetwork, setScanningNetwork] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    const [error, setError] = useState<string | null>(null);
    const [savedPath, setSavedPath] = useState<string | null>(null);

    // -------------------------------------------------------------------------
    // Load networks
    // -------------------------------------------------------------------------

    const refreshNetworks = useCallback(async () => {
        setLoadingNetworks(true);
        setError(null);

        try {
            const result = await invoke<Lan[]>("get_networks");

            setNetworks((previous) =>
                result.map((network) => {
                    const existing = previous.find(
                        (item) => item.id === network.id
                    );

                    return {
                        ...network,
                        whitelisted: existing?.whitelisted ?? false,
                    };
                })
            );
        } catch (err) {
            setError(String(err));
        } finally {
            setLoadingNetworks(false);
        }
    }, []);

    useEffect(() => {
        refreshNetworks();
    }, [refreshNetworks]);

    // -------------------------------------------------------------------------
    // Enable / disable network
    // -------------------------------------------------------------------------

    async function toggleNetwork(network: Lan) {
        setError(null);

        if (network.whitelisted) {
            setNetworks((previous) =>
                previous.map((item) =>
                    item.id === network.id
                        ? { ...item, whitelisted: false }
                        : item
                )
            );

            setHosts((previous) =>
                previous.filter(
                    (host) => host.networkCidr !== network.cidr
                )
            );

            return;
        }

        setScanningNetwork(network.id);

        try {
            const discovered = await invoke<Omit<Host, "selected">[]>(
                "scan_network",
                { cidr: network.cidr }
            );

            setHosts((previous) => {
                const otherHosts = previous.filter(
                    (host) => host.networkCidr !== network.cidr
                );

                const updatedHosts: Host[] = discovered.map((host) => {
                    const existing = previous.find(
                        (item) =>
                            item.ip === host.ip &&
                            item.networkCidr === host.networkCidr
                    );

                    return {
                        ...host,
                        selected: existing?.selected ?? false,
                    };
                });

                return [...otherHosts, ...updatedHosts];
            });

            setNetworks((previous) =>
                previous.map((item) =>
                    item.id === network.id
                        ? { ...item, whitelisted: true }
                        : item
                )
            );
        } catch (err) {
            setError(String(err));
        } finally {
            setScanningNetwork(null);
        }
    }

    // -------------------------------------------------------------------------
    // Rescan enabled network
    // -------------------------------------------------------------------------

    async function rescanNetwork(network: Lan) {
        setScanningNetwork(network.id);
        setError(null);

        try {
            const discovered = await invoke<Omit<Host, "selected">[]>(
                "scan_network",
                { cidr: network.cidr }
            );

            setHosts((previous) => {
                const otherHosts = previous.filter(
                    (host) => host.networkCidr !== network.cidr
                );

                const updatedHosts: Host[] = discovered.map((host) => {
                    const existing = previous.find(
                        (item) =>
                            item.ip === host.ip &&
                            item.networkCidr === host.networkCidr
                    );

                    return {
                        ...host,
                        selected: existing?.selected ?? false,
                    };
                });

                return [...otherHosts, ...updatedHosts];
            });
        } catch (err) {
            setError(String(err));
        } finally {
            setScanningNetwork(null);
        }
    }

    // -------------------------------------------------------------------------
    // Host selection
    // -------------------------------------------------------------------------

    function toggleHost(ip: string, networkCidr: string) {
        setHosts((previous) =>
            previous.map((host) =>
                host.ip === ip && host.networkCidr === networkCidr
                    ? { ...host, selected: !host.selected }
                    : host
            )
        );
    }

    // -------------------------------------------------------------------------
    // Save profile
    // -------------------------------------------------------------------------

    async function confirmSetup() {
        setSaving(true);
        setError(null);

        const profile: Profile = {
            networks: networks.map((network) => ({
                id: network.id,
                interface: network.interface,
                ip: network.ip,
                cidr: network.cidr,
                enabled: network.whitelisted,
            })),
            hosts,
        };

        try {
            const path = await invoke<string>("save_profile", {
                profile,
            });

            setSavedPath(path);
        } catch (err) {
            setError(String(err));
        } finally {
            setSaving(false);
        }
    }

    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------

    const enabledNetworks = networks.filter(
        (network) => network.whitelisted
    );

    const selectedHosts = hosts.filter((host) => host.selected);

    return (
        <main className="min-h-screen bg-zinc-950 text-zinc-100">
            <div className="mx-auto max-w-5xl px-6 py-10">

                {/* Header */}

                <header className="mb-10 flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-semibold tracking-tight">
                            NLSM
                        </h1>

                        <p className="mt-1 text-sm text-zinc-500">
                            Nosana LAN Server Monitor
                        </p>
                    </div>

                    <div className="flex items-center gap-3">
                        <button
                            onClick={refreshNetworks}
                            disabled={loadingNetworks}
                            className="rounded-lg border border-zinc-800 px-4 py-2 text-sm text-zinc-300 transition hover:bg-zinc-900 disabled:opacity-50"
                        >
                            {loadingNetworks ? "Refreshing..." : "Refresh"}
                        </button>

                        <Link
                            to="/dashboard"
                            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
                        >
                            Open dashboard
                        </Link>
                    </div>
                </header>

                {/* Error */}

                {error && (
                    <div className="mb-6 rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
                        {error}
                    </div>
                )}

                {/* Available networks */}

                <section className="mb-10">
                    <div className="mb-4 flex items-center justify-between">
                        <h2 className="text-lg font-medium">
                            Available networks
                        </h2>

                        <span className="text-xs text-zinc-500">
                            {networks.length} found
                        </span>
                    </div>

                    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
                        {networks.length === 0 ? (
                            <div className="px-5 py-8 text-center text-sm text-zinc-500">
                                {loadingNetworks
                                    ? "Discovering networks..."
                                    : "No networks found."}
                            </div>
                        ) : (
                            <div className="divide-y divide-zinc-800">
                                {networks.map((network) => (
                                    <div
                                        key={network.id}
                                        className="flex items-center justify-between gap-4 px-5 py-4"
                                    >
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="font-medium">
                                                    {network.interface}
                                                </span>

                                                {network.whitelisted && (
                                                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400">
                                                        Enabled
                                                    </span>
                                                )}
                                            </div>

                                            <div className="mt-1 text-sm text-zinc-500">
                                                {network.ip} · {network.cidr}
                                            </div>
                                        </div>

                                        <div className="flex shrink-0 items-center gap-2">
                                            {network.whitelisted && (
                                                <button
                                                    onClick={() => rescanNetwork(network)}
                                                    disabled={scanningNetwork === network.id}
                                                    className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
                                                >
                                                    {scanningNetwork === network.id
                                                        ? "Scanning..."
                                                        : "Rescan"}
                                                </button>
                                            )}

                                            <button
                                                onClick={() => toggleNetwork(network)}
                                                disabled={scanningNetwork === network.id}
                                                className={`rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${
                                                    network.whitelisted
                                                        ? "border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                                                        : "bg-blue-600 text-white hover:bg-blue-500"
                                                }`}
                                            >
                                                {scanningNetwork === network.id
                                                    ? "Scanning..."
                                                    : network.whitelisted
                                                        ? "Disable"
                                                        : "Enable"}
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </section>

                {/* Discovered hosts */}

                <section className="mb-10">
                    <div className="mb-4 flex items-center justify-between">
                        <h2 className="text-lg font-medium">
                            Discovered hosts
                        </h2>

                        <span className="text-xs text-zinc-500">
                            {hosts.length} found · {selectedHosts.length} selected
                        </span>
                    </div>

                    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
                        {enabledNetworks.length === 0 ? (
                            <div className="px-5 py-8 text-center text-sm text-zinc-500">
                                Enable a network to discover hosts.
                            </div>
                        ) : hosts.length === 0 ? (
                            <div className="px-5 py-8 text-center text-sm text-zinc-500">
                                No hosts discovered yet.
                            </div>
                        ) : (
                            <div className="divide-y divide-zinc-800">
                                {hosts.map((host) => (
                                    <label
                                        key={`${host.networkCidr}-${host.ip}`}
                                        className="flex cursor-pointer items-center justify-between gap-4 px-5 py-4 transition hover:bg-zinc-800/40"
                                    >
                                        <div className="flex min-w-0 items-center gap-3">
                                            <input
                                                type="checkbox"
                                                checked={host.selected}
                                                onChange={() => toggleHost(host.ip, host.networkCidr)}
                                                className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 accent-blue-500"
                                            />

                                            <div className="min-w-0">
                                                <div className="truncate text-sm font-medium">
                                                    {host.hostname}
                                                </div>

                                                <div className="mt-1 text-xs text-zinc-500">
                                                    {host.ip}
                                                </div>
                                            </div>
                                        </div>

                                        <span className="shrink-0 text-xs text-zinc-600">
                                            {host.networkCidr}
                                        </span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
                </section>

                {/* Save configuration */}

                <section className="flex flex-col items-start justify-between gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 sm:flex-row sm:items-center">
                    <div>
                        <h2 className="font-medium">
                            Save configuration
                        </h2>

                        <p className="mt-1 text-sm text-zinc-500">
                            {selectedHosts.length} hosts selected across{" "}
                            {enabledNetworks.length} enabled networks.
                        </p>

                        {savedPath && (
                            <p className="mt-2 break-all text-xs text-emerald-400">
                                Saved to: {savedPath}
                            </p>
                        )}
                    </div>

                    <button
                        onClick={confirmSetup}
                        disabled={saving}
                        className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
                    >
                        {saving ? "Saving..." : "Confirm"}
                    </button>
                </section>
            </div>
        </main>
    );
};

export const Route = createFileRoute("/")({
    component: Home,
});