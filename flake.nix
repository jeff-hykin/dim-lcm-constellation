{
    description = "dim-lcm-constellation: live LCM/Zenoh traffic over a blueprint's module graph, as a dimOS Desktop app";

    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    outputs = { self, nixpkgs }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
            # release asset names (.github/workflows/release.yml), the same spy-<arch>-<os> main.js looks for
            spyAsset = {
                aarch64-darwin = "spy-aarch64-macos";
                x86_64-darwin = "spy-x86_64-macos";
                x86_64-linux = "spy-x86_64-linux";
                aarch64-linux = "spy-aarch64-linux";
            };
        in {
            # the LCM/Zenoh sniffer, built from source: the fallback when the release binary can't be fetched
            packages = forAllSystems (system: pkgs: {
                spy = pkgs.rustPlatform.buildRustPackage {
                    pname = "constellation-spy";
                    version = "0.1.0";
                    src = ./dim/apps/lcmflow/spy;
                    cargoLock.lockFile = ./dim/apps/lcmflow/spy/Cargo.lock;
                    doCheck = false;
                    meta.mainProgram = "spy";
                };
            });

            apps = forAllSystems (system: pkgs: {
                install = {
                    type = "app";
                    program = toString (pkgs.writeShellScript "install" ''
                        set -e
                        app=dim/apps/lcmflow
                        # fetch the backend's remote imports now so the first start is fast
                        ${pkgs.deno}/bin/deno cache --no-lock "$app/main.js"
                        # the spy binary: the newest CI build from the `latest` release, else build it with nix
                        asset=${spyAsset.${system}}
                        mkdir -p "$app/spy/bin"
                        if ${pkgs.curl}/bin/curl -fsSL --retry 2 -o "$app/spy/bin/$asset.part" \
                            "https://github.com/jeff-hykin/dim-lcm-constellation/releases/latest/download/$asset"; then
                            chmod 755 "$app/spy/bin/$asset.part"
                            # rename in: macOS kills a binary overwritten in place after it ran
                            mv -f "$app/spy/bin/$asset.part" "$app/spy/bin/$asset"
                            echo "dim-lcm-constellation: fetched $asset"
                        else
                            rm -f "$app/spy/bin/$asset.part"
                            echo "dim-lcm-constellation: could not fetch $asset, building spy with nix"
                            nix --extra-experimental-features "nix-command flakes" build -L ".#spy" -o "$app/spy/result"
                        fi
                    '');
                };
            });
        };
}
