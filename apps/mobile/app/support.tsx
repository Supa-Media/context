import { LegalPage } from "../features/legal/LegalPage";
import { supportContent } from "../features/legal/content";

export default function SupportRoute() {
  return <LegalPage content={supportContent} />;
}
