{
    description = "Constellation: live multicast/Zenoh traffic over a blueprint's module graph, as a dimOS Desktop app. `nix build .#dimosApp` → bin/dimos-app-server (Deno backend + the native spy + built React frontend)";

    # unstable: the spy's dependencies need a newer rustc than nixos-25.05 has
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    inputs.rust-overlay = {
        url = "github:oxalica/rust-overlay";
        inputs.nixpkgs.follows = "nixpkgs";
    };
    nixConfig = {
        extra-substituters = [ "https://dimos-desktop.cachix.org" ];
        extra-trusted-public-keys = [ "dimos-desktop.cachix.org-1:A4P35aGJGmCan92LWyamtSFXMqaVE+VRFYnrJ8QMTeQ=" ];
    };

    outputs = { self, nixpkgs, rust-overlay }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
            # the spy for <arch> Linux, from any machine: a static musl binary linked by zig, so no Linux builder or cross gcc
            crossSpy = pkgs: arch:
                let
                    target = "${arch}-unknown-linux-musl";
                    toolchain = (import nixpkgs { inherit (pkgs) system; overlays = [ (import rust-overlay) ]; })
                        .rust-bin.stable.latest.minimal.override { targets = [ target ]; };
                in
                (pkgs.makeRustPlatform { cargo = toolchain; rustc = toolchain; }).buildRustPackage {
                    pname = "constellation-spy-${arch}-linux";
                    version = "0.1.0";
                    src = ./spy;
                    cargoLock.lockFile = ./spy/Cargo.lock;
                    nativeBuildInputs = [ pkgs.cargo-zigbuild pkgs.zig ];
                    # cargo-auditable's -Wl,--undefined is a flag zig's linker rejects
                    auditable = false;
                    buildPhase = ''
                        export HOME=$TMPDIR ZIG_GLOBAL_CACHE_DIR=$TMPDIR/zig
                        cargo zigbuild --release --offline --target ${target}
                    '';
                    doCheck = false;
                    installPhase = "install -Dm755 target/${target}/release/spy $out/bin/spy";
                };
            # dimosApp for <arch> Linux: its shell and deno are the target's (cache.nixos.org downloads); the frontend is plain JS
            linuxApp = pkgs: frontend: arch:
                let linux = nixpkgs.legacyPackages."${arch}-linux"; in
                pkgs.writeTextFile {
                    name = "dimos-app-server-${arch}-linux";
                    destination = "/bin/dimos-app-server";
                    executable = true;
                    text = "#!${linux.runtimeShell}\nexport LCMFLOW_SPY=${crossSpy pkgs arch}/bin/spy\nexec ${linux.deno}/bin/deno run -A --no-lock ${./backend}/main.ts --frontend ${frontend} \"$@\"\n";
                };
        in {
            packages = forAll (pkgs: rec {
                # the multicast/Zenoh sniffer the backend runs (stdout: NDJSON traffic metadata)
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
                dimosApp-aarch64-linux = linuxApp pkgs frontend "aarch64";
                dimosApp-x86_64-linux = linuxApp pkgs frontend "x86_64";
            });
        };
}
