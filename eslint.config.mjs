export default [
  { ignores: ["dist/**", "node_modules/**", ".codex/**", "src/**/*.ts", "tests/**/*.ts"] },
  { files: ["src/**/*.js"], rules: { "no-console": "off", "no-unused-vars": "off" } }
];
