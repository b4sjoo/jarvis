export interface LocalCallPlanSchedule {
  date: string;
  time: string;
}

const SCHEDULE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SCHEDULE_TIME = /^(\d{2}):(\d{2})$/;

export function timestampToLocalCallPlanSchedule(
  timestamp: number | undefined
): LocalCallPlanSchedule {
  if (timestamp === undefined) return { date: "", time: "" };
  const local = new Date(timestamp);
  return {
    date: [
      local.getFullYear(),
      String(local.getMonth() + 1).padStart(2, "0"),
      String(local.getDate()).padStart(2, "0"),
    ].join("-"),
    time: `${String(local.getHours()).padStart(2, "0")}:${String(
      local.getMinutes()
    ).padStart(2, "0")}`,
  };
}

export function localCallPlanScheduleToTimestamp(
  schedule: LocalCallPlanSchedule
): number | undefined {
  if (!schedule.date && !schedule.time) return undefined;
  const dateMatch = SCHEDULE_DATE.exec(schedule.date);
  const timeMatch = SCHEDULE_TIME.exec(schedule.time);
  if (!dateMatch || !timeMatch) {
    throw new Error("Choose both a scheduled date and time.");
  }

  const [, yearText, monthText, dayText] = dateMatch;
  const [, hourText, minuteText] = timeMatch;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const local = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    local.getFullYear() !== year ||
    local.getMonth() !== month - 1 ||
    local.getDate() !== day ||
    local.getHours() !== hour ||
    local.getMinutes() !== minute
  ) {
    throw new Error("The scheduled date and time is not valid in this timezone.");
  }
  return local.getTime();
}

export function buildCallPlanTimeOptions(selectedTime = "") {
  const values = Array.from({ length: 24 * 4 }, (_, index) => {
    const hour = Math.floor(index / 4);
    const minute = (index % 4) * 15;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  });
  if (SCHEDULE_TIME.test(selectedTime) && !values.includes(selectedTime)) {
    values.push(selectedTime);
    values.sort();
  }
  return values.map((value) => ({ value, label: formatCallPlanTime(value) }));
}

function formatCallPlanTime(value: string) {
  const match = SCHEDULE_TIME.exec(value);
  if (!match) return value;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour >= 12 ? "PM" : "AM"}`;
}
