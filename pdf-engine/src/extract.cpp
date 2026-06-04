// Implementation de la sous-commande "extract".
//
// Strategie :
// 1. Init PDFium, ouvrir le PDF source.
// 2. Pour chaque page :
//    a. Recuperer page_size (width, height).
//    b. Iterer les page objects PDFium :
//       - TEXT objects -> text_span (typage heuristique : section_banner
//         si gros texte en haut, page_number si petit chiffre en pied,
//         running_header sinon).
//       - IMAGE objects -> slot decoration kind=image.
//       - PATH (vector) objects -> slot decoration kind=vector.
//    c. Ecrire page-NNN.json dans outDir.
//
// Convention bbox : on convertit les coords PDFium (origine bottom-left,
// Y croissant vers le haut) vers la convention du schema (origine top-left).

#include "extract.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "fpdfview.h"
#include "fpdf_text.h"
#include "fpdf_edit.h"

#include "pdfium_init.hpp"
#include "../vendor/json.hpp"

namespace catgen {

using json = nlohmann::ordered_json;
namespace fs = std::filesystem;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Convertit (left, bottom, right, top) en coords PDFium (origine bottom-left)
// vers [x0, y0, x1, y1] en coords schema (origine top-left).
static json toBbox(float left, float bottom, float right, float top, float pageHeight) {
  return json::array({
    left,
    pageHeight - top,
    right,
    pageHeight - bottom,
  });
}

// Formate une couleur RGB (0-255) en "#rrggbb" lowercase.
static std::string toHexColor(unsigned r, unsigned g, unsigned b) {
  char buf[8];
  std::snprintf(buf, sizeof(buf), "#%02x%02x%02x", r & 0xFF, g & 0xFF, b & 0xFF);
  return std::string(buf);
}

// Convertit un buffer UTF-16LE (output PDFium) en UTF-8 std::string.
// Ignore les BOM et les caracteres null de fin.
static std::string utf16LeToUtf8(const unsigned short* data, int charCount) {
  std::string out;
  out.reserve(charCount);
  for (int i = 0; i < charCount; ++i) {
    unsigned short u = data[i];
    if (u == 0) continue;
    if (u < 0x80) {
      out.push_back(static_cast<char>(u));
    } else if (u < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (u >> 6)));
      out.push_back(static_cast<char>(0x80 | (u & 0x3F)));
    } else {
      // Pas de gestion surrogate pairs ici (ASCII/Latin-1/BMP basique suffit
      // pour un catalogue produit). A enrichir si besoin.
      out.push_back(static_cast<char>(0xE0 | (u >> 12)));
      out.push_back(static_cast<char>(0x80 | ((u >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (u & 0x3F)));
    }
  }
  return out;
}

// Heuristique simple : detecte si un texte ressemble a un numero de page
// (1-3 chiffres optionnellement precedes/suivis de "/", "p.", etc.).
static bool looksLikePageNumber(const std::string& s) {
  std::string trimmed;
  for (char c : s) {
    if (!std::isspace(static_cast<unsigned char>(c))) trimmed.push_back(c);
  }
  if (trimmed.empty() || trimmed.size() > 6) return false;
  int digits = 0;
  for (char c : trimmed) {
    if (std::isdigit(static_cast<unsigned char>(c))) ++digits;
    else if (c != '/' && c != '-' && c != '.' && c != 'p' && c != 'P') return false;
  }
  return digits >= 1 && digits <= 4;
}

// Heuristique : "..." ou "....." dans un text = leader de TOC.
static bool hasDotLeader(const std::string& s) {
  return s.find("...") != std::string::npos
      || s.find(". . .") != std::string::npos;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction d'un text object → JSON slot typé
// ─────────────────────────────────────────────────────────────────────────────

struct ExtractedText {
  std::string text;
  float left;
  float bottom;
  float right;
  float top;
  float fontSize;
  std::string fontName;
  std::string colorHex;
};

static bool extractTextObject(FPDF_PAGEOBJECT obj, FPDF_TEXTPAGE textPage,
                               ExtractedText& out) {
  // Texte UTF-16 : 1er appel pour mesurer (en bytes, terminator inclus),
  // puis 2eme appel avec le buffer alloue. textPage peut etre null si la
  // page n'a pas pu etre indexee : on skip proprement.
  if (!textPage) return false;
  unsigned long neededBytes = FPDFTextObj_GetText(obj, textPage, nullptr, 0);
  if (neededBytes <= 2) return false;  // juste le terminator null
  std::vector<unsigned short> buf(neededBytes / 2);
  FPDFTextObj_GetText(obj, textPage, buf.data(), neededBytes);
  out.text = utf16LeToUtf8(buf.data(), static_cast<int>(buf.size()));
  if (out.text.empty()) return false;

  // Bbox
  if (!FPDFPageObj_GetBounds(obj, &out.left, &out.bottom, &out.right, &out.top)) {
    return false;
  }

  // Font size
  if (!FPDFTextObj_GetFontSize(obj, &out.fontSize)) {
    out.fontSize = 0;
  }
  // PDFium retourne la font_size BRUTE (souvent 1.0 sur des PDFs InDesign qui
  // appliquent l'echelle via la matrice). La vraie taille rendue = font_size
  // * |scale| de la matrice. On applique le facteur ici pour avoir une size
  // exploitable par les heuristiques (section_banner si size >= 14, etc.).
  FS_MATRIX mat;
  if (FPDFPageObj_GetMatrix(obj, &mat)) {
    float scaleX = std::sqrt(mat.a * mat.a + mat.b * mat.b);
    if (scaleX > 0) out.fontSize *= scaleX;
  }

  // Font name : on recupere via le FPDF_FONT
  FPDF_FONT font = FPDFTextObj_GetFont(obj);
  if (font) {
    char fontBuf[256] = {0};
    unsigned long flen = FPDFFont_GetBaseFontName(font, fontBuf, sizeof(fontBuf));
    if (flen > 0 && flen <= sizeof(fontBuf)) {
      out.fontName.assign(fontBuf, flen - 1);  // -1 pour exclure le \0 final
      // Strip le prefixe "AAAAAA+" si subset (6 lettres + +)
      auto plus = out.fontName.find('+');
      if (plus == 6) out.fontName = out.fontName.substr(7);
    }
  }
  if (out.fontName.empty()) out.fontName = "Unknown";

  // Couleur fill
  unsigned int r = 0, g = 0, b = 0, a = 0;
  if (FPDFPageObj_GetFillColor(obj, &r, &g, &b, &a)) {
    out.colorHex = toHexColor(r, g, b);
  } else {
    out.colorHex = "#000000";
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Heuristiques de typage des slots
// ─────────────────────────────────────────────────────────────────────────────

// Decide le type de slot pour un text donné, en fonction de sa position et
// de sa taille. Retourne une string parmi les SLOT_TYPES du schema.
static std::string classifyTextSlot(const ExtractedText& t, float pageW, float pageH) {
  // Coords schema (top-left)
  float y0 = pageH - t.top;
  float y1 = pageH - t.bottom;

  // Bandeau de section : deux criteres independants.
  //
  // Critere A — gros texte dans le quart superieur de la page (critere
  // original elargi : 14pt + y<50 -> 11pt + y < 25% hauteur page).
  // Couvre les bandeaux en haut d'une page de section.
  //
  // Critere B — texte large (> 55% de la largeur page) avec taille >= 9pt
  // jusqu'a 60% de la hauteur page. Couvre les bandeaux horizontaux
  // centres (couverts d'un fond colore dans InDesign) et les titres
  // de gamme qui traversent la page.
  //
  // On exclut les textes trop courts (< 2 chars apres trim) pour ne pas
  // classer des numeros de page ou des puces decoratives.
  {
    std::string trimmed = t.text;
    size_t s = 0, e = trimmed.size();
    while (s < e && (trimmed[s] == ' ' || trimmed[s] == '\t')) ++s;
    while (e > s && (trimmed[e-1] == ' ' || trimmed[e-1] == '\t')) --e;
    size_t trimLen = e - s;

    float textWidth = t.right - t.left;
    float relY = (pageH > 0) ? y0 / pageH : 0.0f;
    bool isWide   = (pageW > 0) && textWidth > pageW * 0.55f;
    bool isTop    = relY < 0.25f;
    bool isBig    = t.fontSize >= 11.0f;
    bool isMedium = t.fontSize >= 9.0f;
    // Min 6 chars : exclut "Inox", "Noir", "Gris", "Mat" qui sont des
    // couleurs frequemment ecrites en haut de fiches produit. Sections
    // legitimes ER : "AÉRATEURS"=10, "BIDETS"=6, "BONDES"=6, etc.
    bool notTooShort = trimLen >= 6;

    if (notTooShort && ((isBig && isTop) || (isWide && isMedium && relY < 0.60f))) {
      return "section_banner";
    }
  }

  // Numero de page : tres bas + texte court ressemblant a un numero
  if (y1 > pageH - 40.0f && looksLikePageNumber(t.text)) {
    return "page_number";
  }

  // Toc entry : ligne contenant des dot leaders
  if (hasDotLeader(t.text)) {
    return "toc_entry";
  }

  // Toc title : texte tres gros en haut de page (mais pas sur le bord)
  if (t.fontSize >= 24.0f && y0 < 200.0f) {
    return "toc_title";
  }

  // Defaut : on classe en running_header (catch-all neutre, sera reclasse
  // par Claude au planning ou patche a la main par l'utilisateur).
  return "running_header";
}

// Construit le JSON slot pour un texte.
static json buildTextSlot(const ExtractedText& t, float pageW, float pageH,
                          int& nextId) {
  std::string type = classifyTextSlot(t, pageW, pageH);
  json span = {
    {"text", t.text},
    {"bbox", toBbox(t.left, t.bottom, t.right, t.top, pageH)},
    {"font", t.fontName},
    {"size", t.fontSize},
    {"color", t.colorHex},
  };

  json slot = {
    {"type", type},
    {"id", type + "_" + std::to_string(nextId++)},
    {"bbox", toBbox(t.left, t.bottom, t.right, t.top, pageH)},
    {"label", span},
  };

  // Champs specifiques selon type
  if (type == "page_number") {
    // Tente de parser le numero
    int num = 0;
    for (char c : t.text) {
      if (std::isdigit(static_cast<unsigned char>(c))) num = num * 10 + (c - '0');
    }
    if (num > 0) slot["current_number"] = num;
  } else if (type == "toc_entry") {
    // page_number_text : split heuristique. Une toc entry typique est
    // "Titre de section .................. 42" ou "Titre  42". On extrait
    // les digits trailing comme page_number_text avec une bbox approximee
    // (segment droit du span original). Si pas de digits trailing, on
    // reutilise le label entier (fallback historique).
    const std::string& text = t.text;
    int digitsStart = -1;
    for (int i = static_cast<int>(text.size()) - 1; i >= 0; --i) {
      unsigned char c = static_cast<unsigned char>(text[i]);
      if (std::isdigit(c)) {
        digitsStart = i;
      } else if (c == ' ' || c == '.' || c == '\t') {
        if (digitsStart >= 0) break;
      } else {
        break;
      }
    }
    if (digitsStart > 0 && digitsStart < static_cast<int>(text.size())) {
      std::string numText = text.substr(digitsStart);
      // Bbox approximative : derniere portion (proportionnelle a la
      // longueur du sous-texte). Pas exact mais suffisant pour le
      // reuse cote substitutor (qui re-positionne via insertAtSpan).
      float total = t.right - t.left;
      float fraction = static_cast<float>(numText.size()) / static_cast<float>(text.size());
      float numLeft = t.right - total * fraction;
      json numBbox = toBbox(numLeft, t.bottom, t.right, t.top, pageH);
      slot["page_number_text"] = json{
        {"text", numText},
        {"bbox", numBbox},
        {"font", t.fontName},
        {"size", t.fontSize},
        {"color", t.colorHex},
      };
    } else {
      slot["page_number_text"] = span;
    }
  }

  return slot;
}

// Slot decoration pour une image ou un path vectoriel.
static json buildDecorationSlot(FPDF_PAGEOBJECT obj, const std::string& kind,
                                 float pageH, int& nextId) {
  float left = 0, bottom = 0, right = 0, top = 0;
  if (!FPDFPageObj_GetBounds(obj, &left, &bottom, &right, &top)) {
    return nullptr;
  }
  json bbox = toBbox(left, bottom, right, top, pageH);
  return json{
    {"type", "decoration"},
    {"id", "decoration_" + std::to_string(nextId++)},
    {"bbox", bbox},
    {"kind", kind},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction d'une page complete
// ─────────────────────────────────────────────────────────────────────────────

static json extractPage(FPDF_DOCUMENT doc, int pageIndex) {
  FPDF_PAGE page = FPDF_LoadPage(doc, pageIndex);
  if (!page) {
    std::cerr << "Impossible de charger page " << pageIndex << "\n";
    return nullptr;
  }
  float pageW = FPDF_GetPageWidthF(page);
  float pageH = FPDF_GetPageHeightF(page);

  // text_page : handle requis pour FPDFTextObj_GetText. Charge UNE fois
  // pour la page, ferme apres la boucle. Peut retourner nullptr sur PDF
  // chiffre / forme corrompue : les pages texte sont alors juste skip.
  FPDF_TEXTPAGE textPage = FPDFText_LoadPage(page);
  if (!textPage) {
    std::cerr << "Page " << pageIndex << " : FPDFText_LoadPage a echoue, texte non extrait\n";
  }

  json slots = json::array();
  // raw_spans : TOUS les spans texte de la page sans inference de type. Sert
  // au pipeline V2 (TS) qui porte find_product_blocks/auto_detect_template
  // depuis le moteur V1 Python. Le champ slots reste pour la retro-compat.
  json rawSpans = json::array();
  // raw_images : bbox de toutes les images bitmap. Sert a detecter les
  // variantes couleur (vignettes carrees) et l'image principale du produit.
  json rawImages = json::array();
  // raw_paths : bbox + fillColor des paths colorés (non blanc/transparent).
  // Sert a retrouver la couleur de fond d'un cartouche section_banner pour
  // pouvoir le substituer en preservant la teinte template.
  json rawPaths = json::array();
  int nextId = 0;

  // P5 (audit V2.1) : descente recursive sur les FORM XObjects (groupes
  // d'objets reutilisables courants dans les PDFs InDesign). Sans ca,
  // certains contenus produit sont invisibles dans les page-NN.json.
  std::function<void(FPDF_PAGEOBJECT)> processObject = [&](FPDF_PAGEOBJECT obj) {
    if (!obj) return;
    int type = FPDFPageObj_GetType(obj);
    if (type == FPDF_PAGEOBJ_TEXT) {
      ExtractedText t;
      if (extractTextObject(obj, textPage, t)) {
        bool allSpace = true;
        for (char c : t.text) if (!std::isspace(static_cast<unsigned char>(c))) { allSpace = false; break; }
        if (!allSpace) {
          slots.push_back(buildTextSlot(t, pageW, pageH, nextId));
          rawSpans.push_back({
            {"text", t.text},
            {"bbox", toBbox(t.left, t.bottom, t.right, t.top, pageH)},
            {"font", t.fontName},
            {"size", t.fontSize},
            {"color", t.colorHex},
          });
        }
      }
    } else if (type == FPDF_PAGEOBJ_IMAGE) {
      json slot = buildDecorationSlot(obj, "image", pageH, nextId);
      if (!slot.is_null()) {
        slots.push_back(slot);
        rawImages.push_back(slot["bbox"]);
      }
    } else if (type == FPDF_PAGEOBJ_PATH) {
      // Capture aussi la fillColor si le path est rempli, non blanc, non
      // transparent. Sert au substituteSectionBanners pour matcher le
      // fond colore d'un cartouche.
      float pl=0, pb=0, pr=0, pt=0;
      if (FPDFPageObj_GetBounds(obj, &pl, &pb, &pr, &pt)) {
        unsigned int R=0, G=0, B=0, A=0;
        if (FPDFPageObj_GetFillColor(obj, &R, &G, &B, &A) && A > 0) {
          if (!(R >= 250 && G >= 250 && B >= 250)) {
            rawPaths.push_back({
              {"bbox", toBbox(pl, pb, pr, pt, pageH)},
              {"fill_color", toHexColor(R, G, B)},
            });
          }
        }
      }
      json slot = buildDecorationSlot(obj, "vector", pageH, nextId);
      if (!slot.is_null()) slots.push_back(slot);
    } else if (type == FPDF_PAGEOBJ_FORM) {
      int subN = FPDFFormObj_CountObjects(obj);
      for (int j = 0; j < subN; ++j) {
        processObject(FPDFFormObj_GetObject(obj, j));
      }
    }
  };

  int n = FPDFPage_CountObjects(page);
  for (int i = 0; i < n; ++i) {
    processObject(FPDFPage_GetObject(page, i));
  }

  json result = {
    {"page_number", pageIndex},
    {"page_size", { {"width", pageW}, {"height", pageH} }},
    {"slots", slots},
    {"raw_spans", rawSpans},
    {"raw_images", rawImages},
    {"raw_paths", rawPaths},
    {"extractor_version", "0.3.0"},
  };

  if (textPage) FPDFText_ClosePage(textPage);
  FPDF_ClosePage(page);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entree publique
// ─────────────────────────────────────────────────────────────────────────────

int runExtract(const std::string& inPdf, const std::string& outDir) {
  initPdfium();

  // Ouvrir le PDF
  FPDF_DOCUMENT doc = FPDF_LoadDocument(inPdf.c_str(), nullptr);
  if (!doc) {
    std::cerr << "Impossible d'ouvrir le PDF: " << inPdf
              << " (erreur PDFium: " << FPDF_GetLastError() << ")\n";
    destroyPdfium();
    return 3;
  }

  // Creer le dossier de sortie
  std::error_code ec;
  fs::create_directories(outDir, ec);
  if (ec) {
    std::cerr << "Impossible de creer le dossier de sortie: " << outDir
              << " (" << ec.message() << ")\n";
    FPDF_CloseDocument(doc);
    destroyPdfium();
    return 4;
  }

  int pageCount = FPDF_GetPageCount(doc);
  std::cout << "Pages: " << pageCount << "\n";
  if (pageCount <= 0) {
    std::cerr << "PDF vide ou illisible (pageCount=" << pageCount << ") : "
              << inPdf << "\n";
    FPDF_CloseDocument(doc);
    destroyPdfium();
    return 5;
  }

  for (int i = 0; i < pageCount; ++i) {
    json page = extractPage(doc, i);
    if (page.is_null()) continue;

    // Format du nom de fichier : page-001.json (3 chiffres min)
    char nameBuf[32];
    std::snprintf(nameBuf, sizeof(nameBuf), "page-%03d.json", i);
    fs::path outPath = fs::path(outDir) / nameBuf;

    std::ofstream out(outPath);
    if (!out) {
      std::cerr << "Impossible d'ecrire " << outPath << "\n";
      continue;
    }
    out << page.dump(2) << "\n";
  }

  FPDF_CloseDocument(doc);
  destroyPdfium();
  std::cout << "Extraction OK: " << pageCount << " fichier(s) ecrit(s) dans "
            << outDir << "\n";
  return 0;
}

}  // namespace catgen
