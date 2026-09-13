import { LegalPage } from "../features/legal/LegalPage";
import { privacyContent } from "../features/legal/content";

export default function PrivacyRoute() {
  return <LegalPage content={privacyContent} />;
}
