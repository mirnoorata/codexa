export interface IndexPipelineStage<Context> {
  name: string;
  run(context: Context): Promise<Context> | Context;
}

export async function runIndexPipeline<Context>(initialContext: Context, stages: Array<IndexPipelineStage<Context>>): Promise<Context> {
  let context = initialContext;
  for (const stage of stages) {
    context = await stage.run(context);
  }
  return context;
}
