// catgen-pdf: C++ binary that handles PDF extraction and rendering.
// Implemented subcommands: extract (batch 4 v0.3.x) and render (batch 6).

#include <iostream>
#include <string>
#include "fpdfview.h"
#include "extract.hpp"
#include "render.hpp"
#include "pdfium_init.hpp"

namespace {

// Binary version. Must track extractor_version in extract.cpp.
constexpr const char* kVersion = "0.3.0";

// Prints the help. Convention: same content for --help / -h / no arg.
void printHelp() {
  std::cout
    << "catgen-pdf " << kVersion << "\n"
    << "\n"
    << "Usage:\n"
    << "  catgen-pdf extract <in.pdf> <outdir>\n"
    << "      Extrait les pages du PDF en JSON (1 fichier par page).\n"
    << "      Contient slots typés, raw_spans, raw_images, raw_paths.\n"
    << "\n"
    << "  catgen-pdf render <plan.json> <template.pdf> <templates-dir>\n"
    << "                   <assets-dir> <out.pdf>\n"
    << "      Applique un plan d'operations sur le template et ecrit le\n"
    << "      PDF final. Supporte set_text, insert_text, erase_rect,\n"
    << "      remove_paths_in_bbox, remove_text_in_bbox, draw_circle,\n"
    << "      draw_image, fill_product_slot.\n"
    << "\n"
    << "  catgen-pdf --help     Affiche cette aide.\n"
    << "  catgen-pdf --version  Affiche la version.\n";
}

// Init/destroy PDFium just to validate the link at runtime. If the binary
// can't find libpdfium at launch, it segfaults here => good smoke test.
void smokePdfium() {
  catgen::initPdfium();
  catgen::destroyPdfium();
}

} // namespace

int main(int argc, char** argv) {
  // Run the PDFium smoke test (validates the lib is properly linked + available).
  smokePdfium();

  // No argument: help.
  if (argc < 2) {
    printHelp();
    return 0;
  }

  const std::string cmd = argv[1];

  if (cmd == "--help" || cmd == "-h" || cmd == "help") {
    printHelp();
    return 0;
  }

  if (cmd == "--version" || cmd == "-v") {
    std::cout << kVersion << "\n";
    return 0;
  }

  if (cmd == "extract") {
    if (argc < 4) {
      std::cerr << "Usage: catgen-pdf extract <in.pdf> <outdir>\n";
      return 2;
    }
    return catgen::runExtract(argv[2], argv[3]);
  }

  if (cmd == "render") {
    if (argc < 7) {
      std::cerr << "Usage: catgen-pdf render <plan.json> <template.pdf> "
                   "<templates-dir> <assets-dir> <out.pdf>\n";
      return 2;
    }
    return catgen::runRender(argv[2], argv[3], argv[4], argv[5], argv[6]);
  }

  std::cerr << "Sous-commande inconnue: " << cmd << "\n\n";
  printHelp();
  return 2;
}
