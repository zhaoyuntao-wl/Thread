import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "docs/local/**"] },
  ...tseslint.configs.recommended,
);
