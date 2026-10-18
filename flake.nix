{
  description = "voxmate — Live2D/VRM avatar that speaks with VOICEVOX";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib = pkgs.lib;

        # Tauri v2 runtime/build deps on Linux (WebKitGTK 4.1 + libsoup3).
        # GStreamer is what WebKitGTK uses for media and WebAudio output.
        gstPlugins = with pkgs.gst_all_1; [
          gstreamer
          gst-plugins-base
          gst-plugins-good
          gst-plugins-bad
        ];
        linuxLibs =
          with pkgs;
          [
            webkitgtk_4_1
            libsoup_3
            gtk3
            glib
            glib-networking
            cairo
            pango
            gdk-pixbuf
            harfbuzz
            at-spi2-atk
            librsvg
            openssl
          ]
          ++ gstPlugins;
      in
      {
        devShells.default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            pkg-config
            rustc
            cargo
            rustfmt
            clippy
            rust-analyzer
            nodejs_22
            pnpm
          ];

          buildInputs = [ pkgs.openssl ] ++ lib.optionals pkgs.stdenv.isLinux linuxLibs;

          shellHook = lib.optionalString pkgs.stdenv.isLinux ''
            export GIO_MODULE_DIR=${pkgs.glib-networking}/lib/gio/modules/
            export GST_PLUGIN_SYSTEM_PATH_1_0=${lib.makeSearchPathOutput "lib" "lib/gstreamer-1.0" gstPlugins}
            export XDG_DATA_DIRS=${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:''${XDG_DATA_DIRS:-}
          '';
        };
      }
    );
}
