import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import vue from "eslint-plugin-vue";
import vueParser from "vue-eslint-parser";

const nestedConditional = {
  selector: "ConditionalExpression ConditionalExpression",
  message: "Use branches instead of nested conditional expressions.",
};

const typedFiles = ["**/*.{ts,tsx,mts,cts,vue}"];
const typedRules = tsPlugin.configs["flat/strict-type-checked"];

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/bin/**",
      "**/obj/**",
      ".audit/**",
      "server/wwwroot/**",
      "web/dist/**",
      "**/test-results/**",
      "**/playwright-report/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,mts,cts,vue}"],
    languageOptions: { parser: tsParser },
    rules: { "no-restricted-syntax": ["error", nestedConditional] },
  },
  ...typedRules.map((config) => ({ ...config, files: typedFiles })),
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: [".vue"],
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: false,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: false,
          allowIIFEs: true,
          allowDirectConstAssertionInArrowFunctions: false,
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
  {
    files: ["**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        projectService: true,
        extraFileExtensions: [".vue"],
      },
    },
    plugins: { vue },
    rules: { "vue/no-restricted-syntax": ["error", nestedConditional] },
  },
];
