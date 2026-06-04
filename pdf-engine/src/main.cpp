// catgen-pdf : binaire C++ qui fait l'extraction et le rendering des PDFs.
// Sous-commandes implementees : extract (lot 4 v0.3.x) et render (lot 6).

#include <iostream>
#include <string>
#include "fpdfview.h"
#include "extract.hpp"
#include "render.hpp"
#include "pdfium_init.hpp"

namespace {

// Version du binaire. Doit suivre extractor_version dans extract.cpp.
constexpr const char* kVersion = "0.3.0";

// Affiche l'aide. Convention : meme contenu pour --help / -h / sans arg.
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

// Init/destroy PDFium juste pour valider le link au runtime. Si le binaire
// ne trouve pas libpdfium au lancement, il segfault ici => bonne smoke.
void smokePdfium() {
  catgen::initPdfium();
  catgen::destroyPdfium();
}

} // namespace

int main(int argc, char** argv) {
  // Lance le smoke PDFium (valide que la lib est bien linkee + dispo).
  smokePdfium();

  // Sans argument : aide.
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
