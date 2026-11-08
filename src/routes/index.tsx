import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type Host = {
    ip: string;
    hostname: string;
    networkCidr: string;
    selected: boolean;
};

type Profile = {
    hosts: Host[];
};

function Index() {
    const navigate = useNavigate();
    const [checkingProfile, setCheckingProfile] = useState(true);

    useEffect(() => {
        let active = true;

        async function initialize() {
            let hasTrackedHosts = false;

            try {
                const profile = await invoke<Profile>("load_profile");
                hasTrackedHosts = profile.hosts?.some((host) => host.selected) ?? false;
            } catch (error) {
                // A missing profile is a normal first-run condition.
                console.debug("No existing profile:", error);
            }

            if (!active) {
                return;
            }

            await navigate({
                to: hasTrackedHosts ? "/dashboard" : "/network-config",
                replace: true,
            });

            if (active) {
                setCheckingProfile(false);
            }
        }

        initialize();

        return () => {
            active = false;
        };
    }, [navigate]);

    return (
        <main className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-100">
            <div className="text-center">
                <div className="mb-3 text-lg font-medium">NLSM</div>
                <div className="text-sm text-zinc-500">
                    {checkingProfile ? "Loading configuration..." : "Opening application..."}
                </div>
            </div>
        </main>
    );
}

export const Route = createFileRoute("/")({
    component: Index,
});
