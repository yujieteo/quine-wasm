{
  description = "quine-wasm: one portable HTML file for an Emscripten program and its files";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      each = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      devShells = each (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.emscripten pkgs.nodejs ]; };
      });
    };
}
