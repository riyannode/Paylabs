import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

type PayLabsCheckpointer = ReturnType<typeof PostgresSaver.fromConnString>;

let cachedCheckpointer: PayLabsCheckpointer | null = null;

export function isLangGraphCheckpointEnabled(): boolean {
  return process.env.PAYLABS_LANGGRAPH_CHECKPOINT_ENABLED === "true";
}

export function getPayLabsLangGraphCheckpointer(): PayLabsCheckpointer | undefined {
  if (!isLangGraphCheckpointEnabled()) {
    return undefined;
  }

  const dbUrl =
    process.env.PAYLABS_LANGGRAPH_CHECKPOINT_DATABASE_URL ||
    process.env.DATABASE_URL;

  if (!dbUrl) {
    throw new Error(
      "PAYLABS_LANGGRAPH_CHECKPOINT_ENABLED=true but PAYLABS_LANGGRAPH_CHECKPOINT_DATABASE_URL or DATABASE_URL is not configured",
    );
  }

  if (!cachedCheckpointer) {
    cachedCheckpointer = PostgresSaver.fromConnString(dbUrl);
  }

  return cachedCheckpointer;
}
