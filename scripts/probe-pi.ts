import { loadDotenv } from "../src/dotenv.ts";
loadDotenv();
import { createModels } from "@earendil-works/pi-ai";
import { minimaxCnProvider } from "@earendil-works/pi-ai/providers/minimax-cn";

// pi-ai 的 minimax-cn 通道默认读 MINIMAX_CN_API_KEY；本项目统一用 MINIMAX_API_KEY
if (!process.env.MINIMAX_CN_API_KEY && process.env.MINIMAX_API_KEY) {
  process.env.MINIMAX_CN_API_KEY = process.env.MINIMAX_API_KEY;
}
const models = createModels();
models.setProvider(minimaxCnProvider());
const model = models.getModel("minimax-cn", "MiniMax-M3")!;
const resp = await models.completeSimple(model, {
  messages: [{ role: "user", content: "只回复两个字：连通", timestamp: Date.now() }],
});
console.log("stopReason:", resp.stopReason);
console.log("errorMessage:", (resp as any).errorMessage ?? "(无)");
console.log("text:", resp.content.filter((b) => b.type === "text").map((b) => (b as any).text));
console.log("usage:", JSON.stringify(resp.usage));
