import json
from typing import Optional, Dict, Any

def extract_json_plan(text: str) -> Optional[Dict[str, Any]]:
    """
    Extracts a JSON object from a string, parsing markdown code blocks or raw JSON.
    Returns None if no valid JSON object is found.
    """
    if not text:
        return None
    text = text.strip()
    candidates = []

    if "```" in text:
        for p in text.split("```"):
            p = p.strip()
            if p.startswith("json"):
                p = p[4:].strip()
            if p.startswith("{"):
                candidates.append(p)
    
    if text.startswith("{"):
        candidates.append(text)
        
    if "{" in text and "}" in text:
        candidates.append(text[text.find("{"): text.rfind("}") + 1])

    for c in candidates:
        try:
            return json.loads(c)
        except json.JSONDecodeError:
            continue
            
    return None
