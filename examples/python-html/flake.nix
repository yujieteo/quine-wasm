{
  description = "python-html: CPython in one portable HTML file";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      each = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      # No C compiler from Nix: the native build uses the system cc, and the
      # build script fetches the pinned emsdk for the wasm build.
      devShells = each (pkgs: {
        default = pkgs.mkShellNoCC { packages = [ pkgs.nodejs pkgs.python3 pkgs.pkg-config pkgs.curl pkgs.git pkgs.unzip ]; };
      });
    };
}
