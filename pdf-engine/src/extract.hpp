// Sous-commande "extract" : prend un PDF source et produit un page-NNN.json
// par page dans un dossier de sortie. Format conforme a
// src/v2/schemas/extracted-page.schema.json.
#pragma once

#include <string>

namespace catgen {

// Retourne 0 si OK, code d'erreur sinon.
int runExtract(const std::string& inPdf, const std::string& outDir);

}  // namespace catgen
