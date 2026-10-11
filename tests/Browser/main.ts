import { createApp, h, Suspense } from "vue";
import ui from "@nuxt/ui/vue-plugin";
import FixtureApp from "./FixtureApp.vue";
import "../../web/src/style.css";

createApp({ render: () => h(Suspense, null, { default: () => h(FixtureApp) }) })
  .use(ui)
  .mount("#app");
