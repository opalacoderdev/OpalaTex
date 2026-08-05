import inspect
from typing import Any, Dict
from agenticblocks.core.block import Block

def block_to_tool_schema(block: Block) -> Dict[str, Any]:
    """Generates an OpenAI-compatible function schema from a Block transparently."""
    
    # If it is a direct MCP Tool with a ready-made schema from the server:
    if getattr(block, "is_mcp_proxy", False):
        schema = block.raw_mcp_schema
    else:
        # Obtain dynamic Pydantic Schema representation for native Python Tools
        schema = block.input_schema().model_json_schema()
        
    class_doc = inspect.getdoc(block.__class__)
    if class_doc and class_doc.startswith("Usage docs:"):
        class_doc = ""
        
    run_doc = inspect.getdoc(block.run)
    
    doc_parts = []
    if getattr(block, "description", None):
        doc_parts.append(block.description)
    if class_doc:
        doc_parts.append(f"Details: {class_doc}")
    if run_doc:
        doc_parts.append(f"Instructions: {run_doc}")
        
    final_description = "\n\n".join(doc_parts).strip()
    if not final_description:
        final_description = f"Executes the block task: {block.name}"
    
    return {
        "type": "function",
        "function": {
            "name": block.name,
            "description": final_description,
            "parameters": schema
        }
    }
