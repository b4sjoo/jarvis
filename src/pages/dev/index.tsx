import { AIProviders, DecisionsProvider, MemoryBase } from "./components";
import { useSettings } from "@/hooks";
import { PageLayout } from "@/layouts";

const DevSpace = () => {
  const settings = useSettings();

  return (
    <PageLayout title="Dev Space" description="Manage your dev space">
      <AIProviders {...settings} />

      <DecisionsProvider />

      <MemoryBase />
    </PageLayout>
  );
};

export default DevSpace;
