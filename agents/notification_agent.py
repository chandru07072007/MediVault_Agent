import logging
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend.config import get_settings

logger = logging.getLogger(__name__)

class NotificationAgent:
    """Agent responsible for sending email notifications and package completion alerts."""
    
    def send(self, data) -> str:
        """Dispatch a notification alert (real SMTP or mock fallback)."""
        email = None
        message = "Package upload event occurred."
        
        if isinstance(data, dict):
            email = data.get("email")
            message = data.get("message", message)
        elif isinstance(data, str):
            email = data
            
        settings = get_settings()
        # Fallback to default configured notification email if not explicitly provided
        if not email:
            email = getattr(settings, "NOTIFICATION_EMAIL", None)
            
        if not email:
            logger.warning("No recipient email specified for notification.")
            return "No recipient email configured."

        logger.info(f"Notification triggered for email={email}. Message: {message}")
        print(f"--- EMAIL TRIGGERED to {email} ---", flush=True)
        print(f"Content: {message}", flush=True)
        print("---------------------------------", flush=True)

        smtp_host = getattr(settings, "SMTP_HOST", "smtp.gmail.com")
        smtp_port = int(getattr(settings, "SMTP_PORT", 587))
        smtp_user = getattr(settings, "SMTP_USER", "")
        smtp_password = getattr(settings, "SMTP_PASSWORD", "")

        if smtp_user and smtp_password:
            try:
                # Prepare MIME message
                msg = MIMEMultipart()
                msg['From'] = smtp_user
                msg['To'] = email
                msg['Subject'] = "MediPack AI - Clinical Notification Alert"
                msg.attach(MIMEText(message, 'plain'))
                
                # Connect and send
                with smtplib.SMTP(smtp_host, smtp_port) as server:
                    server.starttls()
                    server.login(smtp_user, smtp_password)
                    server.sendmail(smtp_user, email, msg.as_string())
                    
                logger.info(f"Email notification successfully sent via SMTP to {email}")
                return f"Notification sent successfully to {email}"
            except Exception as e:
                logger.exception(f"Failed to send SMTP email to {email}")
                return f"SMTP send failed: {str(e)} (Mock log completed)"
        else:
            logger.info("SMTP credentials not fully set. Logged notification to console.")
            return f"Mock notification logged to console for {email}"
