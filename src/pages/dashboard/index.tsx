import { Card, CardDescription, CardHeader, CardTitle } from "@/components";
import { PageLayout } from "@/layouts";

const Dashboard = () => {
  return (
    <PageLayout
      title="Dashboard"
      description="Personal Jarvis workspace status and setup checklist."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>Personal Mode</CardTitle>
            <CardDescription>
              Paid unlocks, hosted API usage, telemetry, and commercial update
              services are disabled for this fork.
            </CardDescription>
          </CardHeader>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>Provider Setup</CardTitle>
            <CardDescription>
              Configure your own AI and speech providers in Dev Space before
              using live meeting assistance.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    </PageLayout>
  );
};

export default Dashboard;
