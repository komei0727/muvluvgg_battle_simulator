import { bootstrap } from "./bootstrap/index.js";

try {
  await bootstrap();
} catch (error) {
  console.error("muvluvgg-battle-simulator failed to start:", error);
  process.exit(1);
}
