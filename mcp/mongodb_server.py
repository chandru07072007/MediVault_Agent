import asyncio
import logging
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mcp.server import Server
from mcp.types import Tool, TextContent
import mcp.server.stdio
from tools import mongodb_tool

# Set up logging to stderr so it doesn't pollute stdout stream
logging.basicConfig(level=logging.INFO, stream=sys.stderr)
logger = logging.getLogger(__name__)

server = Server("medipack-mongodb-server")

@server.list_tools()
async def handle_list_tools() -> list[Tool]:
    return [
        Tool(
            name="find_package",
            description="Find package metadata by ID or search filter.",
            inputSchema={
                "type": "object",
                "properties": {
                    "package_id": {"type": "string", "description": "ID of the package (optional)"},
                    "filter": {"type": "object", "description": "MongoDB search filter dict (optional)"}
                }
            }
        ),
        Tool(
            name="update_package",
            description="Update status, summary, or category of a package.",
            inputSchema={
                "type": "object",
                "properties": {
                    "package_id": {"type": "string", "description": "ID of the package"},
                    "status": {"type": "string", "description": "New status for the package"},
                    "summary": {"type": "string", "description": "Generated summary (optional)"},
                    "category": {"type": "string", "description": "Package category classification (optional)"}
                },
                "required": ["package_id", "status"]
            }
        ),
        Tool(
            name="delete_package",
            description="Delete a package from MongoDB.",
            inputSchema={
                "type": "object",
                "properties": {
                    "package_id": {"type": "string", "description": "ID of the package"}
                },
                "required": ["package_id"]
            }
        )
    ]

@server.call_tool()
async def handle_call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        if name == "find_package":
            pkg_id = arguments.get("package_id")
            flt = arguments.get("filter")
            
            if pkg_id:
                res = mongodb_tool.get_package(pkg_id)
                return [TextContent(type="text", text=str(res or "Package not found."))]
            elif flt:
                res = mongodb_tool.search_packages(flt)
                return [TextContent(type="text", text=str(res))]
            else:
                return [TextContent(type="text", text="Please specify either package_id or filter.")]
                
        elif name == "update_package":
            pkg_id = arguments["package_id"]
            status = arguments["status"]
            summary = arguments.get("summary")
            category = arguments.get("category")
            
            success = mongodb_tool.update_package_status(pkg_id, status, summary, category)
            return [TextContent(type="text", text="Success" if success else "Failed to update package.")]
            
        elif name == "delete_package":
            pkg_id = arguments["package_id"]
            success = mongodb_tool.delete_package(pkg_id)
            return [TextContent(type="text", text="Deleted successfully." if success else "Failed to delete package.")]
            
        else:
            raise ValueError(f"Unknown tool: {name}")
    except Exception as e:
        logger.exception("Error processing tool call")
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
