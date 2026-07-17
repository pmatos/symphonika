import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      ".stryker-tmp/**",
      "symphony/**",
      "scripts/**",
      "eslint.config.js"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.mjs", "fuzz/*.mjs"]
        },
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    rules: {
      "@typescript-eslint/no-floating-promises": "error"
    }
  },
  {
    files: ["fuzz/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off"
    }
  },
  eslintConfigPrettier
);
