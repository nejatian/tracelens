package com.tracelens.api;

import com.tracelens.model.AnalysisResult;
import com.tracelens.service.AnalysisService;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.List;

@RestController
@RequestMapping("/api/incidents")
@CrossOrigin(origins = "${tracelens.cors.allowed-origin:http://localhost:3000}")
public class AnalysisController {

    private final AnalysisService analysisService;

    public AnalysisController(AnalysisService analysisService) {
        this.analysisService = analysisService;
    }

    @PostMapping(value = "/analyze", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public AnalysisResult analyze(
            @RequestParam("files") List<MultipartFile> files,
            @RequestParam(value = "clue", defaultValue = "") String clue,
            @RequestParam(value = "suspiciousCall", defaultValue = "") String suspiciousCall
    ) throws IOException {
        if (files.isEmpty() || files.stream().allMatch(MultipartFile::isEmpty)) {
            throw new IllegalArgumentException("Add at least one non-empty log file.");
        }
        if (clue.isBlank() && suspiciousCall.isBlank()) {
            throw new IllegalArgumentException("Add a clue or suspicious call before starting the investigation.");
        }
        return analysisService.analyze(files, clue, suspiciousCall);
    }
}
