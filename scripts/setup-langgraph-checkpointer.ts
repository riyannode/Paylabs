import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

async function main() {
  const dbUrl =
    process.env.PAYLABS_LANGGRAPH_CHECKPOINT_DATABASE_URL ||
    process.env.DATABASE_URL;

  if (!dbUrl) {
    throw new Error(
      "Missing PAYLABS_LANGGRAPH_CHECKPOINT_DATABASE_URL or DATABASE_URL",
    );
  }

  const checkpointer = PostgresSaver.fromConnString(dbUrl);
  await checkpointer.setup();

  console.log("LangGraph checkpoint tables are ready.");
}

main().catch((error) => {
  console.error(
    "LangGraph checkpointer setup failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
