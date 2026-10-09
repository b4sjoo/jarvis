import { useApp } from "@/contexts";
import { useState } from "react";
import { MEETING_INPUT_LANGUAGES } from "@/config/meeting-input-languages";

export default function MeetingInputLanguages() {
  const { meetingInputLanguages, onSetMeetingInputLanguages } = useApp();
  const [saveError, setSaveError] = useState<string>();
  return <section className="py-6 border-t space-y-3" aria-labelledby="meeting-input-languages-title">
    <h2 id="meeting-input-languages-title" className="text-lg font-semibold">Meeting Input Languages</h2>
    <div className="flex flex-wrap gap-6">
      {MEETING_INPUT_LANGUAGES.map(language => <label key={language.code} className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={meetingInputLanguages.includes(language.code)}
          disabled={meetingInputLanguages.length === 1 && meetingInputLanguages.includes(language.code)}
          onChange={event => setSaveError(onSetMeetingInputLanguages(event.target.checked
            ? [...meetingInputLanguages, language.code]
            : meetingInputLanguages.filter(code => code !== language.code)))} />
        {language.label}
      </label>)}
    </div>
    {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
    {!meetingInputLanguages.length && <p role="alert" className="text-sm text-destructive">Language settings are invalid. Select at least one language.</p>}
  </section>;
}
