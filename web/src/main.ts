import { createApp } from "vue";
import { clerkPlugin } from "@clerk/vue";
import ui from "@nuxt/ui/vue-plugin";
import App from "./App.vue";
import "./style.css";
import { loadApplication, type ApplicationBootstrap } from "./habits";

type Configuration = {
  bootstrap: ApplicationBootstrap | null;
  key: string | null;
  message: string | null;
};
async function loadConfiguration(): Promise<Configuration> {
  try {
    const config = await loadApplication();
    return {
      bootstrap: config,
      key: config.clerkPublishableKey,
      message: config.clerkPublishableKey
        ? null
        : "Set the Clerk publishable key and issuer using the README startup instructions.",
    };
  } catch {
    return {
      bootstrap: null,
      key: null,
      message:
        "The app could not load its sign-in configuration. Check that the backend is ready.",
    };
  }
}
const config = await loadConfiguration();
const app = createApp(App, {
  setupMessage: config.message,
  bootstrap: config.bootstrap,
});
app.use(ui);
if (config.key) app.use(clerkPlugin, { publishableKey: config.key });
app.mount("#app");
