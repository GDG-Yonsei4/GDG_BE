const express = require("express");
const router = express.Router();
const { bucket } = require("./gcs");

router.post("/signed-url", async (req, res) => {
  try {
    const { fileName, contentType } = req.body;

    if (!fileName || !contentType) {
      return res.status(400).json({ error: "fileName and contentType required" });
    }

    const file = bucket.file(fileName);

    const options = {
      version: "v4",
      action: "write",
      expires: Date.now() + 5 * 60 * 1000, // 5 min
      contentType,
    };

    const [url] = await file.getSignedUrl(options);

    return res.json({
      uploadUrl: url,
      method: "PUT",
      expiresIn: "5 minutes",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate signed URL" });
  }
});

module.exports = router;
