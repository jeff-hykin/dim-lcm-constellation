{
    description = "LCM Constellation: live LCM/Zenoh traffic over a blueprint's module graph, as a dimOS Desktop app. `nix build .#dimosApp` → bin/dimos-app-server (Deno backend + the native spy + built React frontend)";

    # unstable: the spy's dependencies need a newer rustc than nixos-25.05 has
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    nixConfig = {
        extra-substituters = [ "https://dimos-desktop.cachix.org" ];
        extra-trusted-public-keys = [ "dimos-desktop.cachix.org-1:A4P35aGJGmCan92LWyamtSFXMqaVE+VRFYnrJ8QMTeQ=" ];
    };

    outputs = { self, nixpkgs }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
        in {
            packages = forAll (pkgs: rec {
                # the LCM/Zenoh sniffer the backend runs (stdout: NDJSON traffic metadata)
                spy = pkgs.rustPlatform.buildRustPackage {
                    pname = "constellation-spy";
                    version = "0.1.0";
                    src = ./spy;
                    cargoLock.lockFile = ./spy/Cargo.lock;
                    doCheck = false;
                    meta.mainProgram = "spy";
                };
                frontend = pkgs.buildNpmPackage {
                    pname = "lcm-constellation-frontend";
                    version = "0.1.0";
                    src = ./frontend;
                    # `nix build .#frontend` prints the right hash when package-lock.json changes
                    npmDepsHash = "sha256-SnPwokE4iJVnJ71rWkJ40jYdMCLWYf+cLZKIbx5mHMU=";
                    installPhase = "cp -r dist $out";
                };
                dimosApp = pkgs.writeShellScriptBin "dimos-app-server" ''
                    export LCMFLOW_SPY=${spy}/bin/spy
                    exec ${pkgs.deno}/bin/deno run -A --no-lock ${./backend}/main.ts --frontend ${frontend} "$@"
                '';
                default = dimosApp;
            });
        };
}
