export {};

declare module "vue" {
  export interface GlobalComponents {
    UAlert: (typeof import("@nuxt/ui/components/Alert.vue"))["default"];
    UApp: (typeof import("@nuxt/ui/components/App.vue"))["default"];
    UButton: (typeof import("@nuxt/ui/components/Button.vue"))["default"];
    UCheckbox: (typeof import("@nuxt/ui/components/Checkbox.vue"))["default"];
    UFormField: (typeof import("@nuxt/ui/components/FormField.vue"))["default"];
    UInput: (typeof import("@nuxt/ui/components/Input.vue"))["default"];
    USlideover: (typeof import("@nuxt/ui/components/Slideover.vue"))["default"];
  }
}
