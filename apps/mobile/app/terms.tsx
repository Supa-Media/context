import { LegalPage } from "../features/legal/LegalPage";
import { termsContent } from "../features/legal/content";

export default function TermsRoute() {
  return <LegalPage content={termsContent} />;
}
