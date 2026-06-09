// "render" subcommand: applies a plan.json onto a template PDF to
// produce the final PDF. Format compliant with src/v2/schemas/plan.schema.json.
#pragma once

#include <string>

namespace catgen {

// Returns 0 if OK, an error code otherwise.
int runRender(const std::string& planJson,
              const std::string& templatePdf,
              const std::string& templatesDir,
              const std::string& assetsDir,
              const std::string& outPdf);

}  // namespace catgen
