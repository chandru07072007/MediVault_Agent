import logging
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tools import mongodb_tool, s3_tool, pdf_tool, gemini_tool

logger = logging.getLogger(__name__)

class ReportAgent:
    """Agent responsible for PDF report text extraction, classification, and summarization."""
    
    def summarize_report(self, data) -> dict:
        """Extract text and generate a medical summary/classification."""
        logger.info(f"Summarize report requested: {data}")
        
        package_id = None
        text_content = ""
        
        # Scenario 1: Raw text input
        if isinstance(data, str) and not (len(data) == 24 and all(c in "0123456789abcdef" for c in data)):
            text_content = data
            
        # Scenario 2: Dict containing package_id or text
        elif isinstance(data, dict):
            package_id = data.get("package_id")
            text_content = data.get("text", "")
            
        # Scenario 3: String representation of package_id
        elif isinstance(data, str):
            package_id = data
            
        if package_id and not text_content:
            # Fetch package metadata to find file_key
            package = mongodb_tool.get_package(package_id)
            if not package:
                return {"status": "error", "message": f"Package not found for ID: {package_id}"}
                
            file_key = package.get("file_key")
            if not file_key:
                return {"status": "error", "message": f"No file_key found in package: {package_id}"}
                
            try:
                # Download report binary from S3
                pdf_bytes = s3_tool.download_file(
                    file_key=file_key,
                    bucket_name=package.get("bucket") or package.get("bucket_name"),
                    user_id=package.get("user_id")
                )
                
                # Extract PDF text
                text_content = pdf_tool.extract_text_from_pdf(pdf_bytes)
                if not text_content:
                    text_content = f"Medical file: {package.get('file_name', 'Unnamed report')}"
            except Exception as e:
                logger.exception("Failed to retrieve file or extract text from S3")
                return {"status": "error", "message": f"S3 text retrieval failed: {str(e)}"}
                
        if not text_content:
            return {"status": "error", "message": "No text content found or retrieved."}
            
        # Generate summary and key insights using Gemini
        ai_summary = gemini_tool.summarize_text(text_content)
        category = gemini_tool.classify_report(text_content)
        
        summary_text = ai_summary.get("summary", "")
        insights = ai_summary.get("insights", [])
        
        # If we have a package ID, save the results in the database
        if package_id:
            mongodb_tool.update_package_status(
                package_id=package_id,
                status="completed",
                summary=summary_text,
                category=category
            )
            # Update insights array in document
            try:
                from bson import ObjectId
                from backend.database.db import packages_collection, uploads_collection
                query_id = ObjectId(package_id) if len(package_id) == 24 else package_id
                packages_collection.update_one({"_id": query_id}, {"$set": {"insights": insights}})
                uploads_collection.update_one({"_id": query_id}, {"$set": {"insights": insights}})
            except Exception:
                pass

            # Automatically dispatch a notification via NotificationAgent
            try:
                from backend.config import get_settings
                from agents.notification_agent import NotificationAgent
                settings = get_settings()
                recipient_email = getattr(settings, "NOTIFICATION_EMAIL", "")
                if recipient_email:
                    pkg = mongodb_tool.get_package(package_id)
                    file_name = pkg.get("file_name") or pkg.get("filename") or "Unknown File"
                    notify_agent = NotificationAgent()
                    notify_message = (
                        f"Clinical Summary Ingested Successfully!\n\n"
                        f"File Name: {file_name}\n"
                        f"Classification: {category}\n\n"
                        f"Executive Summary:\n{summary_text}\n\n"
                        f"Insights extracted:\n" + "\n".join([f"- {ins}" for ins in insights])
                    )
                    notify_agent.send({"email": recipient_email, "message": notify_message})
            except Exception as notify_err:
                logger.warning(f"Failed to auto-dispatch notification: {notify_err}")
                
        return {
            "status": "success",
            "summary": summary_text,
            "insights": insights,
            "category": category,
            "package_id": package_id
        }
