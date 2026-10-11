import { createApp } from "vue";
import { clerkPlugin } from "@clerk/vue";
import ui from "@nuxt/ui/vue-plugin";
import App from "./App.vue";
import "./style.css";
import { z } from "zod";

const schema = z.object({ clerkPublishableKey: z.string().nullable() });
async function loadConfiguration() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("Configuration request failed.");
    const config = schema.parse(await response.json());
    return {
      key: config.clerkPublishableKey,
      message: config.clerkPublishableKey
        ? null
        : "Set the Clerk publishable key and issuer using the README startup instructions.",
    };
  } catch {
    return {
      key: null,
      message:
        "The app could not load its sign-in configuration. Check that the backend is ready.",
    };
  }
}
const config = await loadConfiguration();
const app = createApp(App, { setupMessage: config.message });
app.use(ui);
if (config.key) app.use(clerkPlugin, { publishableKey: config.key });
app.mount("#app");
