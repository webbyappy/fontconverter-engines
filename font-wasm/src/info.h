// info.h -- "fontwrap info": describe a font file as one line of JSON (P1 plan, section 3.3).
#ifndef FONTWRAP_INFO_H_
#define FONTWRAP_INFO_H_

#include <string>

#include "common.h"

namespace fw {

enum Container { kUnknown, kSfnt, kCollection, kWoff, kWoff2, kEot };

Container detect_container(const Bytes& in);

// One JSON object (ASCII only, no newline), starting with "ok":true,"command":"info". Throws Error when the file is
// not a font container fontwrap reads, or its header or directory is damaged. Table data is never decoded.
std::string info_json(const Bytes& in);

}  // namespace fw

#endif  // FONTWRAP_INFO_H_
