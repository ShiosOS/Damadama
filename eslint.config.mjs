import tsParser from "@typescript-eslint/parser";
import vue from "eslint-plugin-vue";
import vueParser from "vue-eslint-parser";

const nestedConditional = {
  selector: "ConditionalExpression ConditionalExpression",
  message: "Use branches instead of nested conditional expressions.",
};

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
    files: ["**/*.{js,mjs,cjs,ts,tsx,vue}"],
    languageOptions: { parser: tsParser },
    rules: { "no-restricted-syntax": ["error", nestedConditional] },
  },
  {
    files: ["**/*.vue"],
    languageOptions: { parser: vueParser, parserOptions: { parser: tsParser } },
    plugins: { vue },
    rules: { "vue/no-restricted-syntax": ["error", nestedConditional] },
  },
];
