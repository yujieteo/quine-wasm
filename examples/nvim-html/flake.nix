{
  description = "Neovim with its config and plugins in one portable HTML file";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    neovim-src = {
      url = "github:neovim/neovim/v0.12.6";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, neovim-src }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          # The native Neovim build inputs give the host code generator (nlua0).
          inputsFrom = [ pkgs.neovim-unwrapped ];
          packages = with pkgs; [ emscripten cmake ninja nodejs curl gnutar gzip neovim-unwrapped ];
          NVIM_SRC = "${neovim-src}";
        };
      });
    };
}
