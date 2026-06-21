import asyncio
import logging
import sys
import os
import base64

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mcp.server import Server
from mcp.types import Tool, TextContent
import mcp.server.stdio
from tools import s3_tool

# Set up logging to stderr so it doesn't pollute stdout stream
logging.basicConfig(level=logging.INFO, stream=sys.stderr)
logger = logging.getLogger(__name__)

server = Server("medipack-s3-server")

@server.list_tools()
async def handle_list_tools() -> list[Tool]:
    return [
        Tool(
            name="upload_file",
            description="Upload file content to S3.",
            inputSchema={
                "type": "object",
                "properties": {
                    "file_key": {"type": "string", "description": "Destination file key (path) in S3"},
                    "content_base64": {"type": "string", "description": "Base64-encoded string of file bytes"},
                    "bucket_name": {"type": "string", "description": "Optional custom S3 bucket name"}
                },
                "required": ["file_key", "content_base64"]
            }
        ),
        Tool(
            name="download_file",
            description="Download file bytes from S3.",
            inputSchema={
                "type": "object",
                "properties": {
                    "file_key": {"type": "string", "description": "S3 path key of the target file"},
                    "bucket_name": {"type": "string", "description": "Optional custom S3 bucket name"}
                },
                "required": ["file_key"]
            }
        ),
        Tool(
            name="list_files",
            description="List file keys in S3 under a prefix.",
            inputSchema={
                "type": "object",
                "properties": {
                    "prefix": {"type": "string", "description": "Prefix folder path (optional)"},
                    "bucket_name": {"type": "string", "description": "Optional custom S3 bucket name"}
                }
            }
        )
    ]

@server.call_tool()
async def handle_call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        if name == "upload_file":
            file_key = arguments["file_key"]
            content_b64 = arguments["content_base64"]
            bucket = arguments.get("bucket_name")
            
            file_bytes = base64.b64decode(content_b64)
            res = s3_tool.upload_file(file_key, file_bytes, bucket)
            return [TextContent(type="text", text=str(res))]
            
        elif name == "download_file":
            file_key = arguments["file_key"]
            bucket = arguments.get("bucket_name")
            
            file_bytes = s3_tool.download_file(file_key, bucket)
            # Encode response as base64 to preserve binary safety
            encoded = base64.b64encode(file_bytes).decode("utf-8")
            return [TextContent(type="text", text=encoded)]
            
        elif name == "list_files":
            prefix = arguments.get("prefix", "")
            bucket = arguments.get("bucket_name")
            
            res = s3_tool.list_files(prefix, bucket)
            return [TextContent(type="text", text=str(res))]
            
        else:
            raise ValueError(f"Unknown tool: {name}")
    except Exception as e:
        logger.exception("Error processing S3 tool call")
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
