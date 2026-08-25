export default [
  { ignores: ["dist/**", "node_modules/**", ".codex/**"] },
  { files: ["src/**/*.ts", "tests/**/*.ts"], rules: { "no-console": "off", "no-unused-vars": "off" } }
];
