export const ANALYTICS_EVENTS = {
  APP_STARTED: "app_started",
} as const;

export const captureEvent = async (
  _eventName: string,
  _properties?: Record<string, any>
) => {
  return;
};

export const trackAppStart = async (
  _appVersion: string,
  _instanceId: string
) => {
  return;
};
