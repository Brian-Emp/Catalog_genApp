// "extract" subcommand: takes a source PDF and produces one page-NNN.json
// per page in an output directory. Format compliant with
// src/v2/schemas/extracted-page.schema.json.
#pragma once

#include <string>

namespace catgen {

// Returns 0 if OK, an error code otherwise.
int runExtract(const std::string& inPdf, const std::string& outDir);

}  // namespace catgen
