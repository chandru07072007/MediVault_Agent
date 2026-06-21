import asyncio
import logging
import sys
import os
import base64

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mcp.server import Server
from mcp.types import Tool, TextContent
import mcp.server.stdio
from tools import pdf_tool, gemini_tool

# Set up logging to stderr so it doesn't pollute stdout stream
logging.basicConfig(level=logging.INFO, stream=sys.stderr)
logger = logging.getLogger(__name__)

server = Server("medipack-file-server")

@server.list_tools()
async def handle_list_tools() -> list[Tool]:
    return [
        Tool(
            name="read_pdf",
            description="Read local PDF file from filepath or base64 bytes.",
            inputSchema={
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Absolute path to local PDF file (optional)"},
                    "content_base64": {"type": "string", "description": "Base64-encoded PDF bytes (optional)"}
                }
            }
        ),
        Tool(
            name="extract_text",
            description="Extract text content from PDF bytes.",
            inputSchema={
                "type": "object",
                "properties": {
                    "content_base64": {"type": "string", "description": "Base64-encoded PDF bytes"}
                },
                "required": ["content_base64"]
            }
        ),
        Tool(
            name="generate_metadata",
            description="Generate clinical metadata, classification, and summary from text.",
            inputSchema={
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The medical text content to analyze"}
                },
                "required": ["text"]
            }
        )
    ]

@server.call_tool()
async def handle_call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        if name == "read_pdf":
            file_path = arguments.get("file_path")
            content_b64 = arguments.get("content_base64")
            
            pdf_bytes = None
            if file_path:
                # Security check to ensure it reads within the workspace or is valid
                if os.path.exists(file_path):
                    with open(file_path, "rb") as f:
                        pdf_bytes = f.read()
                else:
                    return [TextContent(type="text", text=f"File not found: {file_path}")]
            elif content_b64:
                pdf_bytes = base64.b64decode(content_b64)
                
            if pdf_bytes:
                text = pdf_tool.extract_text_from_pdf(pdf_bytes)
                return [TextContent(type="text", text=text)]
            else:
                return [TextContent(type="text", text="Please specify file_path or content_base64.")]
                
        elif name == "extract_text":
            content_b64 = arguments["content_base64"]
            pdf_bytes = base64.b64decode(content_b64)
            text = pdf_tool.extract_text_from_pdf(pdf_bytes)
            return [TextContent(type="text", text=text)]
            
        elif name == "generate_metadata":
            text = arguments["text"]
            summary_info = gemini_tool.summarize_text(text)
            category = gemini_tool.classify_report(text)
            
            metadata = {
                "category": category,
                "summary": summary_info.get("summary", ""),
                "insights": summary_info.get("insights", [])
            }
            return [TextContent(type="text", text=str(metadata))]
            
        else:
            raise ValueError(f"Unknown tool: {name}")
    except Exception as e:
        logger.exception("Error processing File tool call")
        return [TextContent(type="text", text=f"Error: {str(e)}")]

async def main():
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options()
        )

if __name__ == "__main__":
    asyncio.run(main())
