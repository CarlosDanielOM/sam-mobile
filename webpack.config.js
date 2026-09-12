const path = require("path");
const webpack = require("@nativescript/webpack");
const { IgnorePlugin } = require("webpack");

module.exports = (env) => {
	webpack.init(env);

	webpack.chainWebpack((config) => {
		config.devtool(false);
		config.entryPoints.delete("tns_modules/inspector_modules");
		config.resolve.alias.set(
			"@google/genai",
			path.resolve(__dirname, "node_modules/@google/genai/dist/web/index.mjs"),
		);
		config.plugin("ignore-node-builtins").use(IgnorePlugin, [
			{
				resourceRegExp: /^(node:)?(crypto|http|https|fs|fs\/promises|os|path|zlib|child_process|net|tls|stream)$/,
			},
		]);
		config.resolve.set("fallback", {
			crypto: false,
			http: false,
			https: false,
			fs: false,
			os: false,
			path: false,
			stream: false,
			zlib: false,
			child_process: false,
			net: false,
			tls: false,
		});
		config.set("ignoreWarnings", (config.get("ignoreWarnings") ?? []).concat([
			{
				module: /@earendil-works[\\/]pi-ai/,
				message: /Critical dependency: the request of a dependency is an expression/,
			},
		]));
	});

	return webpack.resolveConfig();
};
