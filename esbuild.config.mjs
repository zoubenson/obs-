import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

// 插件：将 .node 原生模块标记为外部
const nativeNodePlugin = {
  name: "native-node-module",
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (args) => {
      return { path: args.path, external: true };
    });
  },
};

esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron"],
  format: "cjs",
  target: "es2018",
  platform: "node",
  outfile: "main.js",
  minify: prod,
  sourcemap: prod ? false : "inline",
  plugins: [nativeNodePlugin],
}).catch(() => process.exit(1));