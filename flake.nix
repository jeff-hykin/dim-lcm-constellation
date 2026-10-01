{
    description = "dim-lcm-constellation: live LCM/Zenoh traffic over a blueprint's module graph, as a dimOS Desktop app";

    # unstable: the spy's dependencies need a newer rustc than nixos-25.05 has
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    inputs.dim-app.url = "github:jeff-hykin/dim-app/v0.4.0";

    outputs = { self, nixpkgs, dim-app }: {
        packages = dim-app.lib.forAllSystems nixpkgs (pkgs: rec {
            # the LCM/Zenoh sniffer the backend runs
            spy = pkgs.rustPlatform.buildRustPackage {
                pname = "constellation-spy";
                version = "0.1.0";
                src = ./dim/apps/lcmflow/spy;
                cargoLock.lockFile = ./dim/apps/lcmflow/spy/Cargo.lock;
                doCheck = false;
                meta.mainProgram = "spy";
            };
            # dim-app's serve.js (what mkDimosApp wraps), plus the spy's store path for main.js
            dimosApp = pkgs.writeShellScriptBin "dimos-app-server" ''
                export LCMFLOW_SPY=${spy}/bin/spy
                exec ${pkgs.deno}/bin/deno run -A --no-lock ${dim-app}/serve.js \
                    --frontend ${self}/dim/apps/lcmflow/frontend --backend ${self}/dim/apps/lcmflow/main.js "$@"
            '';
        });
    };
}
