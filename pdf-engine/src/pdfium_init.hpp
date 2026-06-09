// Initialization/teardown helpers for the PDFium library. Factors out the
// FPDF_LIBRARY_CONFIG block that was copy-pasted across main/extract/render.
#pragma once
#include "fpdfview.h"

namespace catgen {

inline void initPdfium() {
  FPDF_LIBRARY_CONFIG config;
  config.version = 2;
  config.m_pUserFontPaths = nullptr;
  config.m_pIsolate = nullptr;
  config.m_v8EmbedderSlot = 0;
  FPDF_InitLibraryWithConfig(&config);
}

inline void destroyPdfium() {
  FPDF_DestroyLibrary();
}

}  // namespace catgen
