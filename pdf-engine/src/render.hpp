// Sous-commande "render" : applique un plan.json sur un PDF template pour
// produire le PDF final. Format conforme a src/v2/schemas/plan.schema.json.
#pragma once

#include <string>

namespace catgen {

// Retourne 0 si OK, code d'erreur sinon.
int runRender(const std::string& planJson,
              const std::string& templatePdf,
              const std::string& templatesDir,
              const std::string& assetsDir,
              const std::string& outPdf);

}  // namespace catgen
